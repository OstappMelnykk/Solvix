import { buildVoxelCells, VoxelCell } from './voxel-cell';
import { VoxelGridDto } from './voxel-grid-contract';

// countX x countY x countZ grid, occupied cells given as [ix,iy,iz] tuples.
function gridWithOccupied(countX: number, countY: number, countZ: number, occupiedCells: readonly (readonly [number, number, number])[]): VoxelGridDto {
  const cellCount = countX * countY * countZ;
  const occupancy = new Uint8Array(Math.max(1, Math.ceil(cellCount / 8)));
  for (const [ix, iy, iz] of occupiedCells) {
    const index = ix + iy * countX + iz * countX * countY;
    occupancy[index >> 3] |= 1 << (index & 7);
  }
  return { origin: { x: 0, y: 0, z: 0 }, cellSize: 1, countX, countY, countZ, occupancy };
}

function cellAt(cells: VoxelCell[], ix: number, iy: number, iz: number): VoxelCell {
  const cell = cells.find(c => c.ix === ix && c.iy === iy && c.iz === iz);
  if (!cell) {
    throw new Error(`No cell at (${ix},${iy},${iz})`);
  }
  return cell;
}

describe('buildVoxelCells', () => {
  it('creates one VoxelCell per occupied grid cell', () => {
    const grid = gridWithOccupied(2, 1, 1, [[0, 0, 0], [1, 0, 0]]);

    const cells = buildVoxelCells(grid);

    expect(cells.length).toBe(2);
  });

  it('skips unoccupied cells', () => {
    const grid = gridWithOccupied(3, 1, 1, [[0, 0, 0], [2, 0, 0]]);

    const cells = buildVoxelCells(grid);

    expect(cells.length).toBe(2);
    expect(cells.some(c => c.ix === 1)).toBe(false);
  });

  it('computes 8 corners spanning exactly one cell around its center', () => {
    const grid = gridWithOccupied(1, 1, 1, [[0, 0, 0]]);

    const [cell] = buildVoxelCells(grid);

    expect(cell.corners.length).toBe(8);
    const xs = cell.corners.map(c => c.x);
    const ys = cell.corners.map(c => c.y);
    const zs = cell.corners.map(c => c.z);
    expect(Math.min(...xs)).toBeCloseTo(0, 5);
    expect(Math.max(...xs)).toBeCloseTo(1, 5);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
    expect(Math.max(...ys)).toBeCloseTo(1, 5);
    expect(Math.min(...zs)).toBeCloseTo(0, 5);
    expect(Math.max(...zs)).toBeCloseTo(1, 5);
  });

  it('orders corners 0-3 on the -Z face and 4-7 on the +Z face, matching the serendipity hex convention', () => {
    const grid = gridWithOccupied(1, 1, 1, [[0, 0, 0]]);

    const [cell] = buildVoxelCells(grid);

    expect(cell.corners[0].z).toBeCloseTo(cell.corners[1].z, 5);
    expect(cell.corners[1].z).toBeCloseTo(cell.corners[2].z, 5);
    expect(cell.corners[2].z).toBeCloseTo(cell.corners[3].z, 5);
    expect(cell.corners[4].z).toBeCloseTo(cell.corners[5].z, 5);
    expect(cell.corners[5].z).toBeCloseTo(cell.corners[6].z, 5);
    expect(cell.corners[6].z).toBeCloseTo(cell.corners[7].z, 5);
    expect(cell.corners[0].z).toBeLessThan(cell.corners[4].z);
  });

  it('cross-links neighbors that are also occupied, by direct reference', () => {
    const grid = gridWithOccupied(2, 1, 1, [[0, 0, 0], [1, 0, 0]]);

    const cells = buildVoxelCells(grid);
    const left = cellAt(cells, 0, 0, 0);
    const right = cellAt(cells, 1, 0, 0);

    expect(left.neighbors[1]).toBe(right); // +X
    expect(right.neighbors[0]).toBe(left); // -X
  });

  it('shares the exact same corner instance between two adjacent cells, not just an equal-valued copy', () => {
    const grid = gridWithOccupied(2, 1, 1, [[0, 0, 0], [1, 0, 0]]);

    const cells = buildVoxelCells(grid);
    const left = cellAt(cells, 0, 0, 0);
    const right = cellAt(cells, 1, 0, 0);

    // Cell 0's +X face (corners 1,2,5,6) is cell 1's -X face (corners
    // 0,3,4,7) - same 4 lattice points, so these must be identical
    // object references, not merely numerically equal ones.
    expect(left.corners[1]).toBe(right.corners[0]);
    expect(left.corners[2]).toBe(right.corners[3]);
    expect(left.corners[5]).toBe(right.corners[4]);
    expect(left.corners[6]).toBe(right.corners[7]);
    // Corners on the far side (cell 0's own -X face) are NOT shared with
    // cell 1 at all.
    expect(left.corners[0]).not.toBe(right.corners[0]);
  });

  it('does not share corners between cells that only touch diagonally (no shared face)', () => {
    const grid = gridWithOccupied(2, 2, 1, [[0, 0, 0], [1, 1, 0]]);

    const cells = buildVoxelCells(grid);
    const a = cellAt(cells, 0, 0, 0);
    const b = cellAt(cells, 1, 1, 0);

    // These two cells share exactly one lattice point (a's corner 2 = b's
    // corner 0, both at (1,1,0)) despite not being face-adjacent (hence
    // neighbors stays null for both) - even that single shared corner
    // must still resolve to the same instance.
    expect(a.neighbors.every(n => n === null)).toBe(true);
    expect(a.corners[2]).toBe(b.corners[0]);
  });

  it('leaves a face neighbor null when that cell is not occupied', () => {
    const grid = gridWithOccupied(3, 1, 1, [[0, 0, 0], [2, 0, 0]]);

    const cells = buildVoxelCells(grid);
    const left = cellAt(cells, 0, 0, 0);

    expect(left.neighbors[1]).toBeNull(); // +X, cell 1 is empty
  });

  it('leaves a face neighbor null at the edge of the grid', () => {
    const grid = gridWithOccupied(1, 1, 1, [[0, 0, 0]]);

    const [cell] = buildVoxelCells(grid);

    expect(cell.neighbors.every(n => n === null)).toBe(true);
  });

  it('starts with no batch instance id assigned', () => {
    const grid = gridWithOccupied(1, 1, 1, [[0, 0, 0]]);

    const [cell] = buildVoxelCells(grid);

    expect(cell.batchInstanceId).toBeNull();
  });
});