using System.Numerics;

namespace Solvix.Voxelization;

// Conservative voxelization result as a uniform grid + occupancy bitmask,
// not a list of cube centers - a cube's center is always derivable from
// its (ix,iy,iz) grid index (Origin + cellSize*(index + 0.5)), so shipping
// every center as its own {x,y,z} would repeat the same grid structure the
// caller already knows for free. At the largest grid this project allows
// (MaxCells cells, see VoxelizationService), a JSON array of centers would
// run into tens of MB; the bitmask for the same grid is only
// ceil(cellCount/8) bytes - for 900,000 cells, ~112KB. See
// VoxelizationResultBinarySerializer for the wire format this travels as,
// mirrored by solvix-web/src/app/geometry/voxel-grid-contract.ts's decode.
/// <param name="Origin">
/// World-space position of grid cell (0,0,0)'s minimum corner (not its
/// center) - every other cell's position is derived from this plus
/// <paramref name="CellSize"/> and its own (ix,iy,iz) index, never stored
/// explicitly.
/// </param>
/// <param name="CellSize">
/// The side length of ONE cube, shared by every cell in this grid - the
/// single structural reason this type cannot represent cells of different
/// sizes (see docs/BACKEND_ARCHITECTURE.md). Always 1.0 in practice
/// (<c>VoxelizationService.UnitCubeSize</c>) - "density" is achieved by the
/// caller scaling the input mesh before voxelizing, never by varying this.
/// </param>
/// <param name="CountX">How many cells the grid spans along X.</param>
/// <param name="CountY">How many cells the grid spans along Y.</param>
/// <param name="CountZ">How many cells the grid spans along Z.</param>
/// <param name="Occupancy">
/// One bit per cell, packed 8-to-a-byte (LSB first within each byte, see
/// <see cref="CellIndex"/> for the linearization) - <c>1</c> means the
/// voxelization algorithm decided that cell is inside/touching the
/// imported surface, <c>0</c> means empty. Length is always
/// <c>ceil(CountX*CountY*CountZ / 8)</c> bytes.
/// </param>
internal sealed record VoxelizationResult(Vector3 Origin, float CellSize, int CountX, int CountY, int CountZ, byte[] Occupancy)
{
    /// <param name="ix">Cell index along X, in <c>[0, CountX)</c>.</param>
    /// <param name="iy">Cell index along Y, in <c>[0, CountY)</c>.</param>
    /// <param name="iz">Cell index along Z, in <c>[0, CountZ)</c>.</param>
    /// <param name="countX">The grid's own <see cref="CountX"/> - passed explicitly (not read off an instance) since this is called during construction, before a <see cref="VoxelizationResult"/> exists yet.</param>
    /// <param name="countY">The grid's own <see cref="CountY"/>, same reasoning as <paramref name="countX"/>.</param>
    /// <returns>
    /// The flat bit-index into <see cref="Occupancy"/> (before the
    /// /8, %8 split into byte+bit-within-byte) that cell (ix,iy,iz)
    /// occupies. ix varies fastest, then iy, then iz - this exact ordering
    /// must stay in sync with voxel-grid-contract.ts's own <c>cellIndex</c>.
    /// </returns>
    // Folds the 3D cell index (ix,iy,iz) into ONE flat number - memory
    // (and Occupancy, a plain byte[]) has no real notion of "3D array",
    // only a linear sequence, so a 3D position has to be encoded into a
    // single offset somehow. This is the classic row-major scheme: X
    // varies FASTEST, then Y, then Z - same idea as counting in a
    // mixed-radix number (base countX, then countY, then countZ) instead
    // of base 10. Walking a 2x2x2 grid in ix/iy/iz order gives index
    // 0,1,2,3,4,5,6,7 for (0,0,0),(1,0,0),(0,1,0),(1,1,0),(0,0,1),(1,0,1),
    // (0,1,1),(1,1,1) - ix flips every step, iy every 2 steps, iz every 4.
    // IsOccupied then splits this flat index one level further: index/8
    // picks WHICH byte of Occupancy, index%8 picks WHICH of that byte's 8
    // bits (see the bitwise ops there) - one bit per cell, not one byte,
    // is what keeps a 900,000-cell grid down to ~112KB instead of ~900KB.
    // Used both when VoxelizationService sets a bit and by
    // voxel-grid-contract.ts's decode when reading one - ix varies
    // fastest, then iy, then iz, on BOTH sides, or the two would disagree
    // about which bit means which cell.
    public static int CellIndex(int ix, int iy, int iz, int countX, int countY) =>
        ix + iy * countX + iz * countX * countY;

    /// <param name="ix">Cell index along X, in <c>[0, CountX)</c>.</param>
    /// <param name="iy">Cell index along Y, in <c>[0, CountY)</c>.</param>
    /// <param name="iz">Cell index along Z, in <c>[0, CountZ)</c>.</param>
    /// <returns><c>true</c> if the voxelization algorithm marked this cell as occupied.</returns>
    public bool IsOccupied(int ix, int iy, int iz)
    {
        var index = CellIndex(ix, iy, iz, CountX, CountY);
        return (Occupancy[index / 8] & (1 << (index % 8))) != 0;
    }
}