import { buildVoxelCells, VoxelCell } from './voxel-cell';
import { VoxelGridDto } from './voxel-grid-contract';
import { reshapeElongatedVoxels } from './voxel-reshape';

// Same helper shape as voxel-cell.spec.ts's own gridWithOccupied.
function gridWithOccupied(countX: number, countY: number, countZ: number, occupiedCells: readonly (readonly [number, number, number])[]): VoxelGridDto {
  const cellCount = countX * countY * countZ;
  const occupancy = new Uint8Array(Math.max(1, Math.ceil(cellCount / 8)));
  for (const [ix, iy, iz] of occupiedCells) {
    const index = ix + iy * countX + iz * countX * countY;
    occupancy[index >> 3] |= 1 << (index & 7);
  }
  return { origin: { x: 0, y: 0, z: 0 }, cellSize: 1, countX, countY, countZ, occupancy };
}

function cellAt(cells: readonly VoxelCell[], ix: number, iy: number, iz: number): VoxelCell {
  const cell = cells.find(c => c.ix === ix && c.iy === iy && c.iz === iz);
  if (!cell) {
    throw new Error(`No cell at (${ix},${iy},${iz})`);
  }
  return cell;
}

describe('reshapeElongatedVoxels', () => {
  it('never changes the cell count - every World must show the same topology', () => {
    const occupied: [number, number, number][] = [];
    for (let ix = 0; ix < 5; ix++) {
      occupied.push([ix, 0, 0]);
    }
    const grid = gridWithOccupied(5, 1, 1, occupied);
    const cells = buildVoxelCells(grid);
    const countBefore = cells.length;

    const result = reshapeElongatedVoxels(cells, grid);

    expect(cells.length).toBe(countBefore);
    expect(result.reshapedCellCount).toBe(5);
  });

  it('leaves a uniform (non-tapering) run exactly at its plain lattice corners', () => {
    const occupied: [number, number, number][] = [];
    for (let ix = 0; ix < 5; ix++) {
      occupied.push([ix, 0, 0]);
    }
    const grid = gridWithOccupied(5, 1, 1, occupied);
    const cells = buildVoxelCells(grid);

    reshapeElongatedVoxels(cells, grid);

    const middle = cellAt(cells, 2, 0, 0);
    const xs = middle.corners.map(c => c.x).sort((a, b) => a - b);
    const ys = middle.corners.map(c => c.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(2, 5);
    expect(xs[xs.length - 1]).toBeCloseTo(3, 5);
    expect(ys[0]).toBeCloseTo(0, 5);
    expect(ys[ys.length - 1]).toBeCloseTo(1, 5);
  });

  it('leaves an isolated cell with no viable run completely untouched', () => {
    const grid = gridWithOccupied(3, 3, 3, [[1, 1, 1]]);
    const cells = buildVoxelCells(grid);

    const result = reshapeElongatedVoxels(cells, grid);

    expect(result.reshapedCellCount).toBe(0);
    const cell = cellAt(cells, 1, 1, 1);
    expect(cell.corners.some(c => c.x === 1 && c.y === 1 && c.z === 1)).toBe(true);
    expect(cell.corners.some(c => c.x === 2 && c.y === 2 && c.z === 2)).toBe(true);
  });

  it('smooths a gradual taper into a continuous interpolated boundary, not a staircase', () => {
    const occupied: [number, number, number][] = [];
    for (let ix = 0; ix < 4; ix++) {
      for (let iy = 0; iy <= 3; iy++) {
        occupied.push([ix, iy, 0]);
      }
    }
    // Narrows from Y width 4 to Y width 3 over 4 slices - slope 1/4 = 0.25,
    // under tan(15deg) ~= 0.268, so this stays ONE run.
    for (let ix = 4; ix < 8; ix++) {
      for (let iy = 0; iy <= 2; iy++) {
        occupied.push([ix, iy, 0]);
      }
    }
    const grid = gridWithOccupied(8, 4, 1, occupied);
    const cells = buildVoxelCells(grid);

    const result = reshapeElongatedVoxels(cells, grid);

    expect(result.reshapedCellCount).toBe(4 * 4 + 4 * 3);
    // Cell (3,3,0) sits on the true Y-max wall at its own slice (ix=3) -
    // its "hi" (ix=4) face should NOT still be at the raw staircase value
    // (4, the true boundary at ix=3) or (3, the true boundary at ix=4+) -
    // it should be the SMOOTH linear interpolation between the run's start
    // (Y max wall at 4, x=0) and end (Y max wall at 3, x=8): at x=4 (the
    // run's own halfway point), that's exactly 3.5.
    const cell = cellAt(cells, 3, 3, 0);
    // 2 of this cell's 8 corners sit at (x=4, z=0) - the untouched "low"
    // local corner (y=iy=3, interior, not on any wall) and the "high" one
    // (y=iy+1=4 originally, the actual Y-max WALL corner) - only the
    // latter (highest y among the matches) should move.
    const hiFaceCorner = cell.corners.filter(c => c.x === 4 && c.z === 0).sort((a, b) => b.y - a.y)[0];
    expect(hiFaceCorner).toBeDefined();
    expect(hiFaceCorner!.y).toBeCloseTo(3.5, 5);

    // The Y-min wall (never tapers in this test) must stay exactly at 0
    // throughout - only the tapering side moves.
    const minWallCorner = cellAt(cells, 3, 0, 0)
      .corners.filter(c => c.x === 4 && c.z === 0)
      .sort((a, b) => a.y - b.y)[0];
    expect(minWallCorner!.y).toBeCloseTo(0, 5);
  });

  it('keeps a steep (>15 degree) transition as a hard edge instead of smoothing across it', () => {
    const occupied: [number, number, number][] = [];
    // Shrinks from Y width 4 to Y width 2 over just 2 slices - slope 1
    // (45 degrees), far past the ~15 degree tolerance - this must split
    // into 2 separate (individually untapered) runs, not one smoothed one.
    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy <= 3; iy++) {
        occupied.push([ix, iy, 0]);
      }
    }
    for (let ix = 2; ix < 4; ix++) {
      for (let iy = 0; iy <= 1; iy++) {
        occupied.push([ix, iy, 0]);
      }
    }
    const grid = gridWithOccupied(4, 4, 1, occupied);
    const cells = buildVoxelCells(grid);

    reshapeElongatedVoxels(cells, grid);

    // Every cell still belongs to SOME (individually untapered) run - the
    // steep step doesn't leave anything as a fully untouched plain cube.
    // What must NOT happen is a SMOOTH interpolation straight across the
    // step: the wide run's own end face (x=2, from run A) must stay at its
    // true, un-interpolated boundary (y=4), not something averaged with
    // the narrow run's start.
    const wideEnd = cellAt(cells, 1, 3, 0)
      .corners.filter(c => c.x === 2 && c.z === 0)
      .sort((a, b) => b.y - a.y)[0];
    expect(wideEnd!.y).toBeCloseTo(4, 5);
    const narrowStart = cellAt(cells, 2, 1, 0)
      .corners.filter(c => c.x === 2 && c.z === 0)
      .sort((a, b) => b.y - a.y)[0];
    expect(narrowStart!.y).toBeCloseTo(2, 5);
  });

  it('refuses to reshape a non-rectangular (notched) cross-section', () => {
    // A 2x2 footprint missing one corner - not a filled rectangle in any
    // of its 3 possible axis views, so nothing here is elongated at all.
    const grid = gridWithOccupied(1, 2, 2, [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 0]
    ]);
    const cells = buildVoxelCells(grid);

    const result = reshapeElongatedVoxels(cells, grid);

    expect(result.reshapedCellCount).toBe(0);
  });

  it('reshapes 2 disjoint elongated runs ("multiple cross-sections") independently', () => {
    const occupied: [number, number, number][] = [];
    for (let ix = 0; ix < 5; ix++) {
      occupied.push([ix, 0, 0]); // run A
      occupied.push([ix, 5, 5]); // run B, far away - no shared footprint
    }
    const grid = gridWithOccupied(5, 6, 6, occupied);
    const cells = buildVoxelCells(grid);

    const result = reshapeElongatedVoxels(cells, grid);

    expect(cells.length).toBe(10);
    expect(result.reshapedCellCount).toBe(10);
  });
});
