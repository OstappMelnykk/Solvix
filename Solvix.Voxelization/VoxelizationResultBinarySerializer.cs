namespace Solvix.Voxelization;

// Wire format for Voxelizer's output - binary for the same reason the
// input is (see MeshBinarySerializer): a JSON array of per-cube centers
// would run into tens of MB at the largest grid this project allows.
// Layout, little-endian throughout (matches BinaryWriter's default and the
// reading side's DataView(..., true) - see
// solvix-web/src/app/geometry/voxel-grid-contract.ts, the only consumer of
// this format):
//   [float32 originX, originY, originZ]
//   [float32 cellSize]
//   [uint32 countX, countY, countZ]
//   [occupancy bitmask, ceil(countX*countY*countZ/8) bytes - bit index
//    ix + iy*countX + iz*countX*countY, LSB first within each byte]
internal static class VoxelizationResultBinarySerializer
{
    /// <param name="result">The finished voxel grid (from <see cref="VoxelizationService.Voxelize"/>) to encode - its <see cref="VoxelizationResult.Occupancy"/> bitmask is written out verbatim, not recomputed.</param>
    /// <param name="stream">Destination to write the binary layout (documented above) into - the HTTP response body in practice.</param>
    public static void Serialize(VoxelizationResult result, Stream stream)
    {
        using var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        writer.Write(result.Origin.X);
        writer.Write(result.Origin.Y);
        writer.Write(result.Origin.Z);
        writer.Write(result.CellSize);
        writer.Write((uint)result.CountX);
        writer.Write((uint)result.CountY);
        writer.Write((uint)result.CountZ);
        writer.Write(result.Occupancy);
    }
}