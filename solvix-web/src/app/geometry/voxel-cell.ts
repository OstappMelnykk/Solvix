import * as THREE from 'three';
import { VoxelGridDto, isOccupied } from './voxel-grid-contract';

// One occupied grid cell as a standalone object - deliberately minimal for
// now (no face colors, no FEM node ids, no subdivision state), but this is
// the seam meant to grow into that later: rendering (voxel-hexahedron.ts)
// and any future per-cell data (element/node ids, refinement children)
// attach to a VoxelCell rather than to the render layer, so a voxel stays
// one coherent object no matter how much gets added to it.
export class VoxelCell {
  // Render-layer state - which instance in the shared BatchedMesh this
  // cell's geometry occupies, so it can later be hidden/replaced
  // individually (see the BatchedMesh plan) without rebuilding every other
  // cell. null until the cell has actually been added to a batch.
  batchInstanceId: number | null = null;

  constructor(
    readonly ix: number,
    readonly iy: number,
    readonly iz: number,
    // 8 corners, same local-node order as the 20-node serendipity
    // hexahedron this is meant to grow into (AdaptiveMethods/Solution1's
    // ShapeFunctions.LocalCoords): 0-3 the gamma=-1 (bottom) face, 4-7 the
    // gamma=+1 (top) face, each group ordered (--,+-,++,-+) around its face.
    readonly corners: readonly THREE.Vector3[],
    // One entry per face, in FACE_DIRECTIONS order below - null when that
    // neighbor isn't an occupied cell (or is outside the grid).
    readonly neighbors: (VoxelCell | null)[]
  ) {}
}

// Face order used by both `neighbors` above and buildVoxelCells' adjacency
// lookup - index i's neighbor sits at (ix,iy,iz) + this offset.
export const FACE_DIRECTIONS: readonly [number, number, number][] = [
  [-1, 0, 0], [1, 0, 0], // -X, +X
  [0, -1, 0], [0, 1, 0], // -Y, +Y
  [0, 0, -1], [0, 0, 1] // -Z, +Z
];

// Which of the 6 FACE_DIRECTIONS a raycast hit's face normal best matches -
// the "click a face to add a voxel there" build feature
// (VoxelizationService.addVoxelOnFace) needs this to turn a hit's
// `Intersection.face.normal` into a concrete neighbor direction. Voxels are
// always axis-aligned unit cubes built directly in world space with no
// rotation anywhere in the scene graph (voxel-preview.ts's own doc
// comment), so a genuine hit's normal should already point almost exactly
// along one of these 6 directions - picking the best DOT PRODUCT match
// (rather than requiring an exact component match) is what keeps this
// robust to the normal's own small floating-point drift.
export function faceIndexForNormal(normal: THREE.Vector3): number {
  let bestIndex = 0;
  let bestDot = -Infinity;
  FACE_DIRECTIONS.forEach(([dx, dy, dz], index) => {
    const dot = normal.x * dx + normal.y * dy + normal.z * dz;
    if (dot > bestDot) {
      bestDot = dot;
      bestIndex = index;
    }
  });
  return bestIndex;
}

// The 8 corners of cell (ix,iy,iz), as offsets (0 or 1 per axis) onto the
// GRID'S OWN CORNER LATTICE - a corner at lattice point (ix+dx,iy+dy,iz+dz)
// is shared by every occupied cell touching that point (up to 8 of them),
// so keying a corner by these integer coordinates - not by comparing
// floats - is what lets adjacent cells resolve to the exact same node
// (see buildVoxelCells' `nodes` map below). Same order as VoxelCell's
// corners doc comment (and voxel-hexahedron.ts's FACES/EDGES): 0-3 the
// -Z face, 4-7 the +Z face.
const CORNER_OFFSETS: readonly [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]
];

// Same linearization convention as voxel-grid-contract.ts's cellIndex (ix
// varies fastest, then iy, then iz) - a plain number, not a template
// string, so keying the lookup maps below doesn't allocate a string per
// cell/corner (real cost at the documented MaxCells = 900_000 cap: up to
// ~900k cell keys plus up to ~7.2M corner keys, 8 per cell). ONLY valid
// for coordinates already known to be within [0,countX)x[0,countY)x[0,countZ) -
// callers that might pass an out-of-range coordinate (neighbor lookup at
// the grid's edge) must bounds-check first, since the raw arithmetic can
// otherwise alias a negative coordinate on one axis to a valid index on
// another (e.g. flatIndex(-1, iy, iz) can equal flatIndex(countX-1, iy-1, iz)).
function flatIndex(ix: number, iy: number, iz: number, countX: number, countY: number): number {
  return ix + iy * countX + iz * countX * countY;
}

// World position of ONE corner lattice point - computed directly from its
// own integer coordinates (not derived from a cell's center +/- half),
// so two cells sharing a corner compute the identical float result by
// construction rather than by coincidence.
function latticeCornerPosition(grid: VoxelGridDto, ix: number, iy: number, iz: number): THREE.Vector3 {
  return new THREE.Vector3(grid.origin.x + grid.cellSize * ix, grid.origin.y + grid.cellSize * iy, grid.origin.z + grid.cellSize * iz);
}

// The cell's 8 corners as SHARED Vector3 instances - a corner two
// adjacent occupied cells both touch resolves to the same object (via
// `nodes`, keyed by integer lattice coordinates), not two numerically-
// equal-but-distinct ones. Voxels stay independent objects (their own
// VoxelCell, their own neighbor links) - only the corner NODES they
// happen to share are literally the same instance, the same way two
// elements in the FEM reference project's Mesh share a node through one
// AKT entry rather than each carrying its own copy.
// `nodes` is keyed on the CORNER lattice, one size larger per axis than
// the cell grid (countX+1 x countY+1 x countZ+1 possible lattice points) -
// every CORNER_OFFSETS combination keeps each coordinate within
// [0,countX] etc, always non-negative, so flatIndex is safe here without
// the bounds-check flatIndex's own doc comment warns about for neighbors.
function cellCorners(grid: VoxelGridDto, ix: number, iy: number, iz: number, nodes: Map<number, THREE.Vector3>): THREE.Vector3[] {
  const cornersX = grid.countX + 1;
  const cornersY = grid.countY + 1;
  return CORNER_OFFSETS.map(([dx, dy, dz]) => {
    const key = flatIndex(ix + dx, iy + dy, iz + dz, cornersX, cornersY);
    let node = nodes.get(key);
    if (!node) {
      node = latticeCornerPosition(grid, ix + dx, iy + dy, iz + dz);
      nodes.set(key, node);
    }
    return node;
  });
}

// One VoxelCell per occupied grid cell, with `neighbors` cross-linked to
// each other's actual instances (not just coordinates) - two passes, since
// a cell's neighbor may be discovered only after the cell itself is built.
export function buildVoxelCells(grid: VoxelGridDto): VoxelCell[] {
  const byKey = new Map<number, VoxelCell>();
  const nodes = new Map<number, THREE.Vector3>();
  const cells: VoxelCell[] = [];

  for (let ix = 0; ix < grid.countX; ix++) {
    for (let iy = 0; iy < grid.countY; iy++) {
      for (let iz = 0; iz < grid.countZ; iz++) {
        if (!isOccupied(grid, ix, iy, iz)) {
          continue;
        }
        const cell = new VoxelCell(ix, iy, iz, cellCorners(grid, ix, iy, iz, nodes), new Array(6).fill(null));
        cells.push(cell);
        byKey.set(flatIndex(ix, iy, iz, grid.countX, grid.countY), cell);
      }
    }
  }

  for (const cell of cells) {
    FACE_DIRECTIONS.forEach(([dx, dy, dz], face) => {
      const nx = cell.ix + dx;
      const ny = cell.iy + dy;
      const nz = cell.iz + dz;
      // Bounds-checked BEFORE computing the flat index - see flatIndex's
      // own doc comment for why an out-of-range coordinate can't just be
      // looked up directly (it can alias a different, valid cell's key).
      const inBounds = nx >= 0 && nx < grid.countX && ny >= 0 && ny < grid.countY && nz >= 0 && nz < grid.countZ;
      cell.neighbors[face] = inBounds ? (byKey.get(flatIndex(nx, ny, nz, grid.countX, grid.countY)) ?? null) : null;
    });
  }

  return cells;
}

// Flood-fills the occupied cells of `grid` via face adjacency, treating
// (excludeIx,excludeIy,excludeIz) as unoccupied WITHOUT mutating the grid -
// lets VoxelizationService.removeSelectedVoxel check GEOMETRY_RULES.md's R2
// (a deletion may never split the remaining geometry into more than one
// connected group) before committing, by simulating the removal first.
// Returns the size of every connected component found among what would
// remain; R2 permits the deletion only when there's at most one (0, if the
// excluded cell was the last one left).
export function connectedComponentSizes(grid: VoxelGridDto, excludeIx: number, excludeIy: number, excludeIz: number): number[] {
  const isKept = (ix: number, iy: number, iz: number): boolean =>
    ix >= 0 &&
    ix < grid.countX &&
    iy >= 0 &&
    iy < grid.countY &&
    iz >= 0 &&
    iz < grid.countZ &&
    !(ix === excludeIx && iy === excludeIy && iz === excludeIz) &&
    isOccupied(grid, ix, iy, iz);

  const visited = new Set<number>();
  const sizes: number[] = [];

  for (let ix = 0; ix < grid.countX; ix++) {
    for (let iy = 0; iy < grid.countY; iy++) {
      for (let iz = 0; iz < grid.countZ; iz++) {
        const startKey = flatIndex(ix, iy, iz, grid.countX, grid.countY);
        if (!isKept(ix, iy, iz) || visited.has(startKey)) {
          continue;
        }
        let size = 0;
        const stack: [number, number, number][] = [[ix, iy, iz]];
        visited.add(startKey);
        while (stack.length > 0) {
          const [cx, cy, cz] = stack.pop()!;
          size++;
          for (const [dx, dy, dz] of FACE_DIRECTIONS) {
            const nx = cx + dx;
            const ny = cy + dy;
            const nz = cz + dz;
            if (!isKept(nx, ny, nz)) {
              continue;
            }
            const key = flatIndex(nx, ny, nz, grid.countX, grid.countY);
            if (visited.has(key)) {
              continue;
            }
            visited.add(key);
            stack.push([nx, ny, nz]);
          }
        }
        sizes.push(size);
      }
    }
  }

  return sizes;
}

// All corner NODES referenced by `cells`, deduplicated - a Set collapses
// them by object identity, which works here specifically because
// buildVoxelCells already hands adjacent cells the SAME Vector3 instance
// for a shared corner (see cellCorners' `nodes` map above), not merely
// numerically-equal copies. This is the unique node set voxel-preview.ts
// draws as visible spheres - one per node, never one per (cell, corner)
// pair.
export function collectUniqueNodes(cells: readonly VoxelCell[]): THREE.Vector3[] {
  const nodes = new Set<THREE.Vector3>();
  for (const cell of cells) {
    for (const corner of cell.corners) {
      nodes.add(corner);
    }
  }
  return [...nodes];
}