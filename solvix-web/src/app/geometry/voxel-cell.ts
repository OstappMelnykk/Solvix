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
function cellCorners(grid: VoxelGridDto, ix: number, iy: number, iz: number, nodes: Map<string, THREE.Vector3>): THREE.Vector3[] {
  return CORNER_OFFSETS.map(([dx, dy, dz]) => {
    const key = `${ix + dx},${iy + dy},${iz + dz}`;
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
  const byKey = new Map<string, VoxelCell>();
  const nodes = new Map<string, THREE.Vector3>();
  const cells: VoxelCell[] = [];

  for (let ix = 0; ix < grid.countX; ix++) {
    for (let iy = 0; iy < grid.countY; iy++) {
      for (let iz = 0; iz < grid.countZ; iz++) {
        if (!isOccupied(grid, ix, iy, iz)) {
          continue;
        }
        const cell = new VoxelCell(ix, iy, iz, cellCorners(grid, ix, iy, iz, nodes), new Array(6).fill(null));
        cells.push(cell);
        byKey.set(`${ix},${iy},${iz}`, cell);
      }
    }
  }

  for (const cell of cells) {
    FACE_DIRECTIONS.forEach(([dx, dy, dz], face) => {
      cell.neighbors[face] = byKey.get(`${cell.ix + dx},${cell.iy + dy},${cell.iz + dz}`) ?? null;
    });
  }

  return cells;
}