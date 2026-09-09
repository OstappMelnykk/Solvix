import { countOccupied, fromVoxelGridBinary, isOccupied, voxelCenter } from './voxel-grid-contract';

// Builds the exact byte layout Solvix.Voxelization's internal
// VoxelizationResultBinarySerializer produces, so these tests exercise the
// decoding side against the real wire format.
function encode(originX: number, originY: number, originZ: number, cellSize: number, countX: number, countY: number, countZ: number, occupancy: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(28 + occupancy.length);
  const view = new DataView(buffer);
  view.setFloat32(0, originX, true);
  view.setFloat32(4, originY, true);
  view.setFloat32(8, originZ, true);
  view.setFloat32(12, cellSize, true);
  view.setUint32(16, countX, true);
  view.setUint32(20, countY, true);
  view.setUint32(24, countZ, true);
  new Uint8Array(buffer, 28).set(occupancy);
  return buffer;
}

describe('fromVoxelGridBinary', () => {
  it('reads origin, cellSize, and grid dimensions in wire order', () => {
    const grid = fromVoxelGridBinary(encode(-1, -0.5, -0.5, 1, 2, 1, 1, [0b0000_0010]));

    expect(grid.origin).toEqual({ x: -1, y: -0.5, z: -0.5 });
    expect(grid.cellSize).toBe(1);
    expect(grid.countX).toBe(2);
    expect(grid.countY).toBe(1);
    expect(grid.countZ).toBe(1);
  });

  it('reads the occupancy bytes verbatim', () => {
    const grid = fromVoxelGridBinary(encode(0, 0, 0, 1, 9, 1, 1, [0xff, 0x01]));

    expect(Array.from(grid.occupancy)).toEqual([0xff, 0x01]);
  });

  // Regression: a truncated/corrupted response used to decode "successfully"
  // into a grid whose occupancy silently reads as all-empty past the real
  // data, instead of failing loudly.
  it('throws when the occupancy buffer is too short for the declared grid dimensions', () => {
    // 900 cells need ceil(900/8) = 113 bytes; this response only has 1.
    expect(() => fromVoxelGridBinary(encode(0, 0, 0, 1, 900, 1, 1, [0]))).toThrowError(/truncated/);
  });
});

describe('isOccupied', () => {
  it('reads bit index ix + iy*countX + iz*countX*countY, LSB first', () => {
    // 2x2x1 grid, only cell (1,0,0) (bit index 1) set.
    const grid = fromVoxelGridBinary(encode(0, 0, 0, 1, 2, 2, 1, [0b0000_0010]));

    expect(isOccupied(grid, 0, 0, 0)).toBe(false);
    expect(isOccupied(grid, 1, 0, 0)).toBe(true);
    expect(isOccupied(grid, 0, 1, 0)).toBe(false);
    expect(isOccupied(grid, 1, 1, 0)).toBe(false);
  });

  it('reads a bit past the first byte', () => {
    // 9x1x1 grid, cell (8,0,0) is bit index 8 -> occupancy[1] bit 0.
    const grid = fromVoxelGridBinary(encode(0, 0, 0, 1, 9, 1, 1, [0x00, 0x01]));

    expect(isOccupied(grid, 8, 0, 0)).toBe(true);
    expect(isOccupied(grid, 7, 0, 0)).toBe(false);
  });
});

describe('countOccupied', () => {
  it('counts every set bit across the whole grid', () => {
    // 2x2x1 grid, cells (0,0,0) and (1,1,0) set -> bit indices 0 and 3.
    const grid = fromVoxelGridBinary(encode(0, 0, 0, 1, 2, 2, 1, [0b0000_1001]));

    expect(countOccupied(grid)).toBe(2);
  });

  it('returns 0 for an all-zero occupancy', () => {
    const grid = fromVoxelGridBinary(encode(0, 0, 0, 1, 1, 1, 1, [0]));

    expect(countOccupied(grid)).toBe(0);
  });
});

describe('voxelCenter', () => {
  it('derives a cell center from origin + cellSize*(index + 0.5)', () => {
    const grid = fromVoxelGridBinary(encode(-1, -1, -1, 2, 1, 1, 1, [0b1]));

    expect(voxelCenter(grid, 0, 0, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });
});