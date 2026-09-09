// Decode counterpart to Solvix.Voxelization's internal
// VoxelizationResultBinarySerializer - the only producer of this format.
// Binary, not JSON: a JSON array of per-cube centers would run into tens
// of MB at the largest grid the backend allows (MaxCells = 900,000); this
// grid+bitmask encoding is ~112KB for that same case, because a cube's
// center is fully derivable from its (ix,iy,iz) grid index - see
// voxelCenter below. Layout, little-endian throughout (matches .NET's
// BinaryWriter default):
//   [float32 originX, originY, originZ]
//   [float32 cellSize]
//   [uint32 countX, countY, countZ]
//   [occupancy bitmask, ceil(countX*countY*countZ/8) bytes - bit index
//    ix + iy*countX + iz*countX*countY, LSB first within each byte]
export interface VoxelGridDto {
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly cellSize: number;
  readonly countX: number;
  readonly countY: number;
  readonly countZ: number;
  readonly occupancy: Uint8Array;
}

export function fromVoxelGridBinary(buffer: ArrayBuffer): VoxelGridDto {
  const view = new DataView(buffer);
  const origin = { x: view.getFloat32(0, true), y: view.getFloat32(4, true), z: view.getFloat32(8, true) };
  const cellSize = view.getFloat32(12, true);
  const countX = view.getUint32(16, true);
  const countY = view.getUint32(20, true);
  const countZ = view.getUint32(24, true);
  const occupancy = new Uint8Array(buffer, 28);

  // Declared dimensions must actually be backed by enough occupancy bytes
  // - without this, a truncated/corrupted response silently reads past
  // the real data as `undefined` (isOccupied's bitwise AND against
  // `undefined` evaluates to 0, i.e. "not occupied") instead of failing
  // loudly, hiding a broken response as a merely-empty result.
  const cellCount = countX * countY * countZ;
  const expectedOccupancyBytes = Math.ceil(cellCount / 8);
  if (occupancy.length < expectedOccupancyBytes) {
    throw new Error(
      `Voxel grid response is truncated: ${countX}x${countY}x${countZ} cells need ${expectedOccupancyBytes} occupancy bytes, got ${occupancy.length}.`
    );
  }

  return { origin, cellSize, countX, countY, countZ, occupancy };
}

// Same linearization the backend's VoxelizationResult.CellIndex writes a
// bit at - ix varies fastest, then iy, then iz. Must stay in exact sync
// with that method.
function cellIndex(grid: VoxelGridDto, ix: number, iy: number, iz: number): number {
  return ix + iy * grid.countX + iz * grid.countX * grid.countY;
}

export function isOccupied(grid: VoxelGridDto, ix: number, iy: number, iz: number): boolean {
  const index = cellIndex(grid, ix, iy, iz);
  return (grid.occupancy[index >> 3] & (1 << (index & 7))) !== 0;
}

// Total occupied-cell count - used both by buildVoxelPreview (to size the
// InstancedMesh exactly) and by the settings-panel cube-count display, so
// it lives here once rather than being duplicated in both places.
export function countOccupied(grid: VoxelGridDto): number {
  let count = 0;
  for (let ix = 0; ix < grid.countX; ix++) {
    for (let iy = 0; iy < grid.countY; iy++) {
      for (let iz = 0; iz < grid.countZ; iz++) {
        if (isOccupied(grid, ix, iy, iz)) {
          count++;
        }
      }
    }
  }
  return count;
}

// World-space center of cell (ix,iy,iz) - never received explicitly over
// the wire, always derived from the grid's own origin/cellSize.
export function voxelCenter(grid: VoxelGridDto, ix: number, iy: number, iz: number): { x: number; y: number; z: number } {
  return {
    x: grid.origin.x + grid.cellSize * (ix + 0.5),
    y: grid.origin.y + grid.cellSize * (iy + 0.5),
    z: grid.origin.z + grid.cellSize * (iz + 0.5)
  };
}