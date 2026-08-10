import * as THREE from 'three';

// glTF exporters routinely duplicate a vertex position across triangles that
// share it but need different normals/UVs (hard edges, UV seams) - a closed
// mesh can still show unmatched positions under exact float equality, so
// positions are welded (quantized) before the edge graph is built.
const WELD_PRECISION = 5;

function weldKey(x: number, y: number, z: number): string {
  return `${x.toFixed(WELD_PRECISION)}|${y.toFixed(WELD_PRECISION)}|${z.toFixed(WELD_PRECISION)}`;
}

// A closed (watertight) manifold surface: every edge is shared by exactly 2
// triangles. This is the property the future R3 voxelization candidate
// (docs/IDEAS.md) needs for its inside/outside point test - an open surface
// anywhere makes "is this point inside the body" ill-defined there.
function isGeometryWatertight(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  if (!position) {
    return false;
  }

  const weldedIndex = new Map<string, number>();
  const vertexWeld: number[] = new Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const key = weldKey(position.getX(i), position.getY(i), position.getZ(i));
    let welded = weldedIndex.get(key);
    if (welded === undefined) {
      welded = weldedIndex.size;
      weldedIndex.set(key, welded);
    }
    vertexWeld[i] = welded;
  }

  const indices = geometry.index ? geometry.index.array : Array.from({ length: position.count }, (_, i) => i);

  const edgeCounts = new Map<string, number>();
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