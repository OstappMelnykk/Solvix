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
internal sealed record VoxelizationResult(Vector3 Origin, float CellSize, int CountX, int CountY, int CountZ, byte[] Occupancy)
{
    // Linearization used both when VoxelizationService sets a bit and by
    // voxel-grid-contract.ts's decode when reading one - ix varies
    // fastest, then iy, then iz.
    public static int CellIndex(int ix, int iy, int iz, int countX, int countY) =>
        ix + iy * countX + iz * countX * countY;

    public bool IsOccupied(int ix, int iy, int iz)
    {
        var index = CellIndex(ix, iy, iz, CountX, CountY);
        return (Occupancy[index / 8] & (1 << (index % 8))) != 0;
    }
}