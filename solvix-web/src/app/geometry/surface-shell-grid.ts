import * as THREE from 'three';
import { VoxelGridDto, isOccupied } from './voxel-grid-contract';

// A second, finer grid over the SAME origin/coordinate frame as the
// already-computed solid voxel grid - not a solid fill (there's no
// "inside"/"outside" test here at all), just which fine cells the STL
// surface itself passes through. Reuses VoxelGridDto's own shape/bitmask
// encoding (origin/cellSize/countX/Y/Z/occupancy) - a dense bitmask is a
// little wasteful for something this sparse (only surface cells are ever
// set), but reusing the exact type isOccupied/countOccupied/voxelCenter
// already handle correctly is worth more than the memory it costs, and the
// upper bound is still fixed (SHELL_SUBDIVISIONS^3 times the voxel grid's
// own already-capped cell count - see VoxelizationService's MaxCells).
//
// Why this exists: docs/local-refinement/PROBLEMS.md's Проблема 2 explains
// that a hex's boundary vertices get "snapped" onto the nearest STL surface
// point (isoparametric mapping) - if a manually-painted voxel zone's
// vertices snap onto the WRONG physical surface patch (e.g. a neighboring
// tooth root's surface instead of its own), the element self-intersects.
// This shell grid is what lets the user paint a matching zone directly on
// the STL surface (SurfaceZonePaintingService) at a resolution fine enough
// to separate surface patches a coarse voxel grid can't - see
// SHELL_SUBDIVISIONS below.

// How much finer than the voxel grid this shell grid is, per axis - e.g. 5
// means each voxel cell is subdivided into 5x5x5 = 125 shell cells. Chosen
// within the user-requested "4-6x" range: fine enough that two physically
// separate surface patches sharing one coarse voxel (the whole reason this
// tool exists) can still land in DIFFERENT shell cells, without inflating
// the occupancy bitmask (SHELL_SUBDIVISIONS^3 times the voxel grid's own
// cell count) more than necessary.
export const SHELL_SUBDIVISIONS = 5;

export function worldPointToShellCell(grid: VoxelGridDto, point: THREE.Vector3): { ix: number; iy: number; iz: number } | null {
  const cell = cellAt(grid, point.x, point.y, point.z);
  return cell ? { ix: cell[0], iy: cell[1], iz: cell[2] } : null;
}

function cellIndexOf(grid: VoxelGridDto, ix: number, iy: number, iz: number): number {
  return ix + iy * grid.countX + iz * grid.countX * grid.countY;
}

function setOccupied(grid: VoxelGridDto, ix: number, iy: number, iz: number): void {
  if (ix < 0 || iy < 0 || iz < 0 || ix >= grid.countX || iy >= grid.countY || iz >= grid.countZ) {
    return;
  }
  const index = cellIndexOf(grid, ix, iy, iz);
  grid.occupancy[index >> 3] |= 1 << (index & 7);
}

// (x,y,z world point) -> the shell cell it falls in, or null if outside the
// grid's own bounds entirely (a triangle can extend past the voxel grid's
// own extent - e.g. right at its edge - without that being an error; such
// samples are simply not markable and are skipped). Exported as
// worldPointToShellCell for SurfaceZonePaintingComponent's own raycast hit
// -> cell lookup (a plain THREE.Raycaster hit against the real STL mesh
// geometry, unlike the voxel tool's BatchedMesh instance-id lookup) - same
// math, one shared implementation.
function cellAt(grid: VoxelGridDto, x: number, y: number, z: number): [number, number, number] | null {
  const ix = Math.floor((x - grid.origin.x) / grid.cellSize);
  const iy = Math.floor((y - grid.origin.y) / grid.cellSize);
  const iz = Math.floor((z - grid.origin.z) / grid.cellSize);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= grid.countX || iy >= grid.countY || iz >= grid.countZ) {
    return null;
  }
  return [ix, iy, iz];
}

// Marks every shell cell triangle (v0,v1,v2) passes through, by walking a
// barycentric lattice of sample points across it, spaced at roughly HALF a
// shell cell's size - close enough together that no cell the triangle
// actually covers can fall entirely between two samples. Deliberately not
// an exact triangle/box overlap test (e.g. the classic 13-axis
// separating-axis test): this only needs to be a good enough approximation
// to paint on (the whole Варіант D tool already accepts "прийнятне
// наближення, не точна геометрія" per PROBLEMS.md), and sampling density
// scales with the SAME thing an exact test would cost anyway - the
// triangle's own extent relative to cell size - while being far simpler to
// get right without any way to visually verify it here.
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchPoint = new THREE.Vector3();

function markTriangle(grid: VoxelGridDto, v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3): void {
  scratchA.subVectors(v1, v0);
  scratchB.subVectors(v2, v0);
  const maxEdgeLength = Math.max(scratchA.length(), scratchB.length(), v2.distanceTo(v1));
  const steps = Math.max(1, Math.ceil(maxEdgeLength / (grid.cellSize * 0.5)));

  // The barycentric lattice below only lands exactly on the centroid
  // (a=b=c=1/3) when `steps` happens to be a multiple of 3 - for a small
  // triangle (the common case, steps=1) it doesn't, so the centroid is
  // marked explicitly here too. assignTriangleZones looks up a triangle's
  // zone by ITS centroid's cell specifically - without this, that lookup
  // could land in a cell this function never actually marked as part of
  // the same triangle, and a legitimately painted triangle would read back
  // as unassigned.
  scratchPoint.set(0, 0, 0).addScaledVector(v0, 1 / 3).addScaledVector(v1, 1 / 3).addScaledVector(v2, 1 / 3);
  const centroidCell = cellAt(grid, scratchPoint.x, scratchPoint.y, scratchPoint.z);
  if (centroidCell) {
    setOccupied(grid, centroidCell[0], centroidCell[1], centroidCell[2]);
  }

  for (let i = 0; i <= steps; i++) {
    const a = i / steps;
    for (let j = 0; j <= steps - i; j++) {
      const b = j / steps;
      const c = 1 - a - b;
      // point = v0*c + v1*a + v2*b (barycentric combination)
      scratchPoint.set(0, 0, 0).addScaledVector(v0, c).addScaledVector(v1, a).addScaledVector(v2, b);
      const cell = cellAt(grid, scratchPoint.x, scratchPoint.y, scratchPoint.z);
      if (cell) {
        setOccupied(grid, cell[0], cell[1], cell[2]);
      }
    }
  }
}

// Builds the shell grid from `object`'s own triangle soup, in WORLD space -
// same "bake matrixWorld into every vertex" approach as
// geometry/mesh-contract.ts's toMeshBinary (the exact bytes the voxel grid
// itself was computed from), so this shell grid lines up with the ALREADY
// rendered voxel grid without any extra alignment step.
export function buildSurfaceShellGrid(object: THREE.Object3D, voxelGrid: VoxelGridDto, subdivisions: number = SHELL_SUBDIVISIONS): VoxelGridDto {
  const countX = voxelGrid.countX * subdivisions;
  const countY = voxelGrid.countY * subdivisions;
  const countZ = voxelGrid.countZ * subdivisions;
  const grid: VoxelGridDto = {
    origin: voxelGrid.origin,
    cellSize: voxelGrid.cellSize / subdivisions,
    countX,
    countY,
    countZ,
    occupancy: new Uint8Array(Math.max(1, Math.ceil((countX * countY * countZ) / 8)))
  };

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
      markTriangle(grid, v0, v1, v2);
    }
  });

  return grid;
}

// Every triangle's own zone, derived from whichever shell cell its CENTROID
// falls in (not "majority of touched cells" - simpler, and matches how a
// voxel's own zone membership is decided by a single index lookup, not a
// vote). -1 for a triangle whose centroid lands outside the grid, or in a
// shell cell no zone claimed. `zoneIdAt` mirrors ZonePaintingService's own
// zoneIdAt signature exactly, so a caller already holding one of those
// (voxel side) doesn't need a different shape here.
export function assignTriangleZones(
  object: THREE.Object3D,
  grid: VoxelGridDto,
  zoneIdAt: (ix: number, iy: number, iz: number) => number | null
): Int16Array {
  object.updateMatrixWorld(true);

  let triangleCount = 0;
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      const position = child.geometry.getAttribute('position');
      if (position) {
        const index = child.geometry.index;
        triangleCount += (index ? index.count : position.count) / 3;
      }
    }
  });

  const triangleZone = new Int16Array(triangleCount).fill(-1);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  let triangleIndex = 0;

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
      centroid.set(0, 0, 0).addScaledVector(v0, 1 / 3).addScaledVector(v1, 1 / 3).addScaledVector(v2, 1 / 3);
      const cell = cellAt(grid, centroid.x, centroid.y, centroid.z);
      triangleZone[triangleIndex] = cell && isOccupied(grid, cell[0], cell[1], cell[2]) ? zoneIdAt(cell[0], cell[1], cell[2]) ?? -1 : -1;
      triangleIndex++;
    }
  });

  return triangleZone;
}
