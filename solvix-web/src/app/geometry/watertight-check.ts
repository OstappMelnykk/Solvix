import * as THREE from 'three';

// glTF exporters routinely duplicate a vertex position across triangles that
// share it but need different normals/UVs (hard edges, UV seams) - a closed
// mesh can still show unmatched positions under exact float equality, so
// positions are welded (quantized) before the edge graph is built.
const WELD_PRECISION = 5;

function weldKey(x: number, y: number, z: number): string {
  return `${x.toFixed(WELD_PRECISION)}|${y.toFixed(WELD_PRECISION)}|${z.toFixed(WELD_PRECISION)}`;
}

// Shared by isGeometryWatertight and findGeometryBoundaryEdges below - welds
// vertex positions, then counts how many triangles use each (welded) edge.
// A closed manifold surface has every edge shared by exactly 2 triangles;
// count 1 is a hole boundary, count >2 is non-manifold - either way, "not 2"
// is the actual defect, and weldedPoints (a representative, un-transformed
// local position per welded vertex) is what lets a caller turn those edges
// back into real 3D line segments afterward.
function buildWeldedEdgeCounts(geometry: THREE.BufferGeometry): { edgeCounts: Map<string, number>; weldedPoints: THREE.Vector3[] } {
  const position = geometry.getAttribute('position');
  const weldedPoints: THREE.Vector3[] = [];
  const edgeCounts = new Map<string, number>();
  if (!position) {
    return { edgeCounts, weldedPoints };
  }

  const weldedIndex = new Map<string, number>();
  const vertexWeld: number[] = new Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = weldKey(x, y, z);
    let welded = weldedIndex.get(key);
    if (welded === undefined) {
      welded = weldedIndex.size;
      weldedIndex.set(key, welded);
      weldedPoints.push(new THREE.Vector3(x, y, z));
    }
    vertexWeld[i] = welded;
  }

  const indices = geometry.index ? geometry.index.array : Array.from({ length: position.count }, (_, i) => i);
  const addEdge = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = vertexWeld[indices[i]];
    const b = vertexWeld[indices[i + 1]];
    const c = vertexWeld[indices[i + 2]];
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  return { edgeCounts, weldedPoints };
}

// A closed (watertight) manifold surface: every edge is shared by exactly 2
// triangles. This is the property the future R3 voxelization candidate
// (docs/IDEAS.md) needs for its inside/outside point test - an open surface
// anywhere makes "is this point inside the body" ill-defined there.
function isGeometryWatertight(geometry: THREE.BufferGeometry): boolean {
  const { edgeCounts } = buildWeldedEdgeCounts(geometry);
  if (edgeCounts.size === 0) {
    return false;
  }
  for (const count of edgeCounts.values()) {
    if (count !== 2) {
      return false;
    }
  }
  return true;
}

export interface BoundaryEdge {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
}

// Every edge belonging to a hole (used by only 1 triangle) or a non-manifold
// seam (used by 3+) - the actual defect isGeometryWatertight only reports as
// a plain boolean, as real 3D points (in `matrixWorld`'s target space) so a
// caller can draw them directly on the geometry instead of just naming the
// file "not watertight" in text.
function findGeometryBoundaryEdges(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): BoundaryEdge[] {
  const { edgeCounts, weldedPoints } = buildWeldedEdgeCounts(geometry);
  const edges: BoundaryEdge[] = [];
  for (const [key, count] of edgeCounts) {
    if (count === 2) {
      continue;
    }
    const [aId, bId] = key.split('_').map(Number);
    edges.push({
      a: weldedPoints[aId].clone().applyMatrix4(matrixWorld),
      b: weldedPoints[bId].clone().applyMatrix4(matrixWorld)
    });
  }
  return edges;
}

// Every boundary edge across every mesh in `object`, in OBJECT's own local
// space - the caller must have already called object.updateMatrixWorld(true)
// with `object` unparented (or otherwise sitting at identity), same
// precondition ImportedGeometryService.set() already satisfies for
// isWatertight(pivot) below, so each descendant's matrixWorld is relative to
// `object` itself rather than some ancestor further up a real scene graph.
export function findHoleBoundaryEdges(object: THREE.Object3D): BoundaryEdge[] {
  const edges: BoundaryEdge[] = [];
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      edges.push(...findGeometryBoundaryEdges(child.geometry, child.matrixWorld));
    }
  });
  return edges;
}

// A hole is literally a missing polygon, not just a rim around one - edges
// alone (findHoleBoundaryEdges) only show its outline. This chains count=1
// edges (a genuine hole boundary; count>=3 non-manifold seams have no single
// well-defined polygon to reconstruct, so those are left out here) back
// into ordered closed loops, one per hole, so a caller can actually fill the
// missing area in instead of just outlining it.
function findGeometryBoundaryLoops(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): THREE.Vector3[][] {
  const { edgeCounts, weldedPoints } = buildWeldedEdgeCounts(geometry);

  const adjacency = new Map<number, number[]>();
  const addAdjacency = (a: number, b: number) => {
    const neighbors = adjacency.get(a);
    if (neighbors) {
      neighbors.push(b);
    } else {
      adjacency.set(a, [b]);
    }
  };
  for (const [key, count] of edgeCounts) {
    if (count !== 1) {
      continue;
    }
    const [aId, bId] = key.split('_').map(Number);
    addAdjacency(aId, bId);
    addAdjacency(bId, aId);
  }

  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const visitedEdges = new Set<string>();
  const loops: THREE.Vector3[][] = [];

  for (const startId of adjacency.keys()) {
    for (const firstNeighbor of adjacency.get(startId)!) {
      const startKey = edgeKey(startId, firstNeighbor);
      if (visitedEdges.has(startKey)) {
        continue;
      }
      visitedEdges.add(startKey);

      // A simple boundary loop visits every vertex exactly once before
      // returning to startId - the guard just bounds a malformed/branching
      // boundary (a vertex shared by 2+ separate holes) so a bad mesh can
      // never hang this in an infinite walk; such a case simply won't close
      // and gets discarded below, same as any other dead-end walk.
      const ids = [startId];
      let previous = startId;
      let current = firstNeighbor;
      let closed = false;
      const guard = adjacency.size + 1;
      while (ids.length <= guard) {
        ids.push(current);
        if (current === startId) {
          closed = true;
          break;
        }
        const next = (adjacency.get(current) ?? []).find(candidate => candidate !== previous && !visitedEdges.has(edgeKey(current, candidate)));
        if (next === undefined) {
          break;
        }
        visitedEdges.add(edgeKey(current, next));
        previous = current;
        current = next;
      }

      if (closed && ids.length >= 4) {
        loops.push(ids.slice(0, -1).map(id => weldedPoints[id].clone().applyMatrix4(matrixWorld)));
      }
    }
  }

  return loops;
}

// Same traversal/precondition as findHoleBoundaryEdges - every genuine hole
// (not non-manifold seam) in `object`, as an ordered closed loop of points
// tracing its missing polygon.
export function findHoleBoundaryLoops(object: THREE.Object3D): THREE.Vector3[][] {
  const loops: THREE.Vector3[][] = [];
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      loops.push(...findGeometryBoundaryLoops(child.geometry, child.matrixWorld));
    }
  });
  return loops;
}

// Groups EVERY boundary edge (both count=1 hole edges AND count>=3 non-
// manifold seams - unlike findGeometryBoundaryLoops, which only chains the
// count=1 kind into a strict, ordered, simple loop and silently drops
// anything that doesn't close cleanly) into connected components by shared
// vertex, via plain BFS - not ordered into a loop, just grouped, since all
// this needs to support is "one representative point per visually distinct
// red patch" for marker placement. This guarantees a marker for every
// defect the outline actually draws, including the ones
// findGeometryBoundaryLoops has to leave unfilled (a branching/non-simple
// boundary, or a non-manifold seam with no single well-defined polygon).
function findGeometryBoundaryClusters(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): THREE.Vector3[][] {
  const { edgeCounts, weldedPoints } = buildWeldedEdgeCounts(geometry);

  const adjacency = new Map<number, number[]>();
  const addAdjacency = (a: number, b: number) => {
    const neighbors = adjacency.get(a);
    if (neighbors) {
      neighbors.push(b);
    } else {
      adjacency.set(a, [b]);
    }
  };
  for (const [key, count] of edgeCounts) {
    if (count === 2) {
      continue;
    }
    const [aId, bId] = key.split('_').map(Number);
    addAdjacency(aId, bId);
    addAdjacency(bId, aId);
  }

  const visited = new Set<number>();
  const clusters: THREE.Vector3[][] = [];
  for (const startId of adjacency.keys()) {
    if (visited.has(startId)) {
      continue;
    }
    const cluster: number[] = [];
    const queue = [startId];
    visited.add(startId);
    while (queue.length > 0) {
      const id = queue.pop()!;
      cluster.push(id);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    clusters.push(cluster.map(id => weldedPoints[id].clone().applyMatrix4(matrixWorld)));
  }

  return clusters;
}

// Same traversal/precondition as findHoleBoundaryEdges - every visually
// distinct red patch the outline draws, grouped so a caller can compute one
// marker position per patch (findHoleBoundaryLoops' own strict closed-loop
// requirement means some real defects never make it into that list at all).
export function findHoleBoundaryClusters(object: THREE.Object3D): THREE.Vector3[][] {
  const clusters: THREE.Vector3[][] = [];
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      clusters.push(...findGeometryBoundaryClusters(child.geometry, child.matrixWorld));
    }
  });
  return clusters;
}

// Whether an imported object is a valid input for future R3 voxelization -
// every mesh in it has to be independently watertight, not just the union,
// since a stray open surface anywhere breaks the inside/outside test there.
export function isWatertight(object: THREE.Object3D): boolean {
  let meshCount = 0;
  let allWatertight = true;

  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    meshCount++;
    if (!isGeometryWatertight(child.geometry)) {
      allWatertight = false;
    }
  });

  return meshCount > 0 && allWatertight;
}