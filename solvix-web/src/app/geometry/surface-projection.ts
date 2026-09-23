import * as THREE from 'three';
import { VoxelCell, FACE_DIRECTIONS, CORNER_OFFSETS } from './voxel-cell';

// Snaps voxelized boundary corners that sit OUTSIDE the real imported STL
// surface back onto it, smoothing the blocky lattice boundary toward the
// actual shape. Conservative voxelization (Solvix.Voxelization) includes
// any cell the surface even slightly touches - a boundary corner can
// therefore end up physically outside the real (often curved) surface,
// sticking out past it. A corner already inside/on the surface is left
// untouched - this is a one-directional smoothing pass, not a general
// re-projection of every boundary vertex.
//
// Deliberately no zone-awareness and no node-splitting here - see
// docs/local-refinement/PROBLEMS.md, Проблема 2 for that harder case
// (topologically disconnected parts sharing one voxel); this file only
// does the simple, unconditional part: "is this point outside the real
// geometry - if so, drop a perpendicular onto the nearest surface point."

// Every world-space triangle of `object`, built once per run and reused
// for every inside/outside test and every closest-point query below.
export function extractWorldTriangles(object: THREE.Object3D): THREE.Triangle[] {
  const triangles: THREE.Triangle[] = [];
  object.updateMatrixWorld(true);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const position = child.geometry.getAttribute('position');
    if (!position) {
      return;
    }
    const index = child.geometry.index;
    const cornerCount = index ? index.count : position.count;
    for (let corner = 0; corner < cornerCount; corner += 3) {
      const i0 = index ? index.getX(corner) : corner;
      const i1 = index ? index.getX(corner + 1) : corner + 1;
      const i2 = index ? index.getX(corner + 2) : corner + 2;
      v0.fromBufferAttribute(position, i0).applyMatrix4(child.matrixWorld);
      v1.fromBufferAttribute(position, i1).applyMatrix4(child.matrixWorld);
      v2.fromBufferAttribute(position, i2).applyMatrix4(child.matrixWorld);
      triangles.push(new THREE.Triangle(v0.clone(), v1.clone(), v2.clone()));
    }
  });

  return triangles;
}

// Which of a cell's 8 corner indices sit on the face pointing in
// `direction` (one of FACE_DIRECTIONS' entries) - derived generically from
// CORNER_OFFSETS rather than hardcoding a second copy of the face/corner
// mapping (voxel-hexahedron.ts's own FACES array exists for the same
// data, but in a different index order than FACE_DIRECTIONS).
function cornerIndicesForFace(direction: readonly [number, number, number]): number[] {
  const axis = direction[0] !== 0 ? 0 : direction[1] !== 0 ? 1 : 2;
  const wantOffset = direction[axis] > 0 ? 1 : 0;
  const indices: number[] = [];
  CORNER_OFFSETS.forEach((offset, i) => {
    if (offset[axis] === wantOffset) {
      indices.push(i);
    }
  });
  return indices;
}

const FACE_CORNER_INDICES = FACE_DIRECTIONS.map(cornerIndicesForFace);

// Every unique boundary corner node - a lattice point exposed on at least
// one face of at least one occupied cell (neighbors[face] === null).
// buildVoxelCells (voxel-cell.ts) already hands every cell touching a
// given lattice point the SAME Vector3 instance, so a plain Set collapses
// duplicates by identity for free.
export function findBoundaryCorners(cells: readonly VoxelCell[]): Set<THREE.Vector3> {
  const corners = new Set<THREE.Vector3>();
  for (const cell of cells) {
    cell.neighbors.forEach((neighbor, face) => {
      if (neighbor !== null) {
        return;
      }
      for (const cornerIndex of FACE_CORNER_INDICES[face]) {
        corners.add(cell.corners[cornerIndex]);
      }
    });
  }
  return corners;
}

// 3 fixed, non-axis-aligned, non-parallel ray directions - mirrors
// Solvix.Voxelization's own InsideTestRays (VoxelizationService.cs):
// a single ray is a single point of failure (it can graze exactly along
// an edge/degenerate feature and miscount), so the inside/outside call is
// a majority vote across 3 independent directions instead.
const RAY_DIRECTIONS: readonly THREE.Vector3[] = [
  new THREE.Vector3(0.9137, 0.2711, 0.3053).normalize(),
  new THREE.Vector3(0.2416, 0.8837, -0.3981).normalize(),
  new THREE.Vector3(-0.5271, 0.3162, 0.7889).normalize()
];

const scratchRay = new THREE.Ray();
const scratchHit = new THREE.Vector3();

// Parity ray-cast: a point is inside a closed surface iff a ray from it
// crosses the surface an ODD number of times. No backface culling (only
// whether a forward hit exists matters, not which side of the triangle
// was hit) - same reasoning as the backend's own Möller-Trumbore test.
function countRayHits(origin: THREE.Vector3, direction: THREE.Vector3, triangles: readonly THREE.Triangle[]): number {
  scratchRay.set(origin, direction);
  let hits = 0;
  for (const triangle of triangles) {
    if (scratchRay.intersectTriangle(triangle.a, triangle.b, triangle.c, false, scratchHit)) {
      hits++;
    }
  }
  return hits;
}

export function isPointOutsideMesh(point: THREE.Vector3, triangles: readonly THREE.Triangle[]): boolean {
  let insideVotes = 0;
  for (const direction of RAY_DIRECTIONS) {
    if (countRayHits(point, direction, triangles) % 2 === 1) {
      insideVotes++;
    }
  }
  return insideVotes * 2 <= RAY_DIRECTIONS.length;
}

// The closest point across ALL of `triangles` to `point` - a plain
// perpendicular projection onto whichever triangle is actually nearest,
// no zone/local restriction (see this file's own header comment for why
// that's out of scope here).
export function closestPointOnMesh(point: THREE.Vector3, triangles: readonly THREE.Triangle[]): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestDistSq = Infinity;
  const scratch = new THREE.Vector3();
  for (const triangle of triangles) {
    triangle.closestPointToPoint(point, scratch);
    const distSq = scratch.distanceToSquared(point);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = (best ?? new THREE.Vector3()).copy(scratch);
    }
  }
  return best;
}

// Ties the pieces together - VoxelizationService's own entry point. Moves
// every boundary corner that's outside the real surface onto its nearest
// point on it, in place; corners already inside/on the surface are left
// untouched. Returns how many corners were actually moved (for a status
// toast).
export function snapExteriorVerticesToSurface(cells: readonly VoxelCell[], object: THREE.Object3D): number {
  const corners = findBoundaryCorners(cells);
  const triangles = extractWorldTriangles(object);
  let movedCount = 0;
  for (const corner of corners) {
    if (!isPointOutsideMesh(corner, triangles)) {
      continue;
    }
    const closest = closestPointOnMesh(corner, triangles);
    if (closest) {
      corner.copy(closest);
      movedCount++;
    }
  }
  return movedCount;
}
