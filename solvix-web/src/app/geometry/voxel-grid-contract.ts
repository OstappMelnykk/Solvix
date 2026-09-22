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
//   [markedForRefinement bitmask, same shape/bit-linearization as the
//    occupancy bitmask immediately above - see markedForRefinement's own
//    doc comment]
export interface VoxelGridDto {
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly cellSize: number;
  readonly countX: number;
  readonly countY: number;
  readonly countZ: number;
  readonly occupancy: Uint8Array;
  // Always a subset of occupancy's 1-bits. 1 means this occupied cell's
  // own volume was found to cover 2+ topologically disconnected pieces of
  // the imported body (docs/local-refinement/PROBLEMS.md, Проблема 2,
  // Варіант B - Solvix.Voxelization's own HasConnectivitySplit) - a
  // candidate for local refinement later. Purely diagnostic today -
  // nothing yet acts on it beyond scene-objects/voxels.ts's own highlight
  // tint.
  readonly markedForRefinement: Uint8Array;
}

export function fromVoxelGridBinary(buffer: ArrayBuffer): VoxelGridDto {
  const view = new DataView(buffer);
  const origin = { x: view.getFloat32(0, true), y: view.getFloat32(4, true), z: view.getFloat32(8, true) };
  const cellSize = view.getFloat32(12, true);
  const countX = view.getUint32(16, true);
  const countY = view.getUint32(20, true);
  const countZ = view.getUint32(24, true);

  // Declared dimensions must actually be backed by enough occupancy bytes
  // - without this, a truncated/corrupted response silently reads past
  // the real data as `undefined` (isOccupied's bitwise AND against
  // `undefined` evaluates to 0, i.e. "not occupied") instead of failing
  // loudly, hiding a broken response as a merely-empty result.
  const cellCount = countX * countY * countZ;
  const expectedBytesPerBitmask = Math.ceil(cellCount / 8);
  const expectedTotalBytes = 28 + expectedBytesPerBitmask * 2;
  if (buffer.byteLength < expectedTotalBytes) {
    throw new Error(
      `Voxel grid response is truncated: ${countX}x${countY}x${countZ} cells need ${expectedBytesPerBitmask} bytes each for occupancy and markedForRefinement, got ${buffer.byteLength - 28} bytes total after the header.`
    );
  }
  const occupancy = new Uint8Array(buffer, 28, expectedBytesPerBitmask);
  const markedForRefinement = new Uint8Array(buffer, 28 + expectedBytesPerBitmask, expectedBytesPerBitmask);

  return { origin, cellSize, countX, countY, countZ, occupancy, markedForRefinement };
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

export function isMarkedForRefinement(grid: VoxelGridDto, ix: number, iy: number, iz: number): boolean {
  const index = cellIndex(grid, ix, iy, iz);
  return (grid.markedForRefinement[index >> 3] & (1 << (index & 7))) !== 0;
}

// Total occupied-cell count - used by the settings-panel cube-count
// display. buildVoxelPreview no longer needs this itself (it counts via
// buildVoxelCells(grid).length instead, since it needs the full VoxelCell
// list anyway), but the display value is still exactly this count, so it
// stays a shared function rather than being reimplemented at the one
// remaining call site.
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

// Sets (or clears) ONE cell, growing the grid's own bounds first if
// (ix,iy,iz) falls outside them - the manual "click a face to add a voxel"
// build feature (VoxelizationService.addVoxelOnFace) needs this since a
// user can build past whatever the server originally covered, e.g. to patch
// a real coverage gap by hand or just extend past the imported mesh's own
// bounding box. This is plain data - returns a NEW grid rather than
// mutating `grid` in place - with every previously occupied cell preserved
// at its (possibly shifted) position; cellSize is never touched, only
// origin/counts/occupancy.
export function withCellSet(grid: VoxelGridDto, ix: number, iy: number, iz: number, occupied: boolean): VoxelGridDto {
  const minX = Math.min(0, ix);
  const minY = Math.min(0, iy);
  const minZ = Math.min(0, iz);
  const countX = Math.max(grid.countX - 1, ix) - minX + 1;
  const countY = Math.max(grid.countY - 1, iy) - minY + 1;
  const countZ = Math.max(grid.countZ - 1, iz) - minZ + 1;
  // How far every existing (and the target) cell's index shifts along each
  // axis - 0 unless the grid actually had to grow in the NEGATIVE direction
  // on that axis (a positive-direction grow needs no shift at all, since
  // index 0 already stays index 0).
  const shiftX = -minX;
  const shiftY = -minY;
  const shiftZ = -minZ;

  const origin = {
    x: grid.origin.x - shiftX * grid.cellSize,
    y: grid.origin.y - shiftY * grid.cellSize,
    z: grid.origin.z - shiftZ * grid.cellSize
  };

  const occupancy = new Uint8Array(Math.max(1, Math.ceil((countX * countY * countZ) / 8)));
  // Carried forward at each existing cell's own (possibly shifted) index,
  // same as occupancy - a manual add/delete has no way to redo
  // HasConnectivitySplit itself (that needs the real STL triangles, which
  // only Solvix.Voxelization has), so this just preserves whatever the
  // server last computed rather than silently dropping it. The newly
  // added cell (if any) is never marked here - it has no server-computed
  // answer yet, and "not marked" is the safe default until the next real
  // re-voxelization.
  const markedForRefinement = new Uint8Array(occupancy.length);
  for (let x = 0; x < grid.countX; x++) {
    for (let y = 0; y < grid.countY; y++) {
      for (let z = 0; z < grid.countZ; z++) {
        if (!isOccupied(grid, x, y, z)) {
          continue;
        }
        const index = x + shiftX + (y + shiftY) * countX + (z + shiftZ) * countX * countY;
        occupancy[index >> 3] |= 1 << (index & 7);
        if (isMarkedForRefinement(grid, x, y, z)) {
          markedForRefinement[index >> 3] |= 1 << (index & 7);
        }
      }
    }
  }

  const targetIndex = ix + shiftX + (iy + shiftY) * countX + (iz + shiftZ) * countX * countY;
  if (occupied) {
    occupancy[targetIndex >> 3] |= 1 << (targetIndex & 7);
  } else {
    occupancy[targetIndex >> 3] &= ~(1 << (targetIndex & 7));
    markedForRefinement[targetIndex >> 3] &= ~(1 << (targetIndex & 7));
  }

  return { origin, cellSize: grid.cellSize, countX, countY, countZ, occupancy, markedForRefinement };
}