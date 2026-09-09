namespace Solvix.Voxelization;

// Sole public surface of this project - everything about voxelization
// (the mesh/grid data shapes, both binary wire formats, the SAT/ray-parity
// algorithm itself) is an internal implementation detail (see
// InternalsVisibleTo in the .csproj, which opens that up only to this
// project's own tests). Callers (Solvix.MeshBuilder's facade) only ever
// see bytes in, bytes out, plus VoxelizationTooLargeException for the one
// error case that needs translating into an HTTP response upstream.
public sealed class Voxelizer
{
    public byte[] Voxelize(byte[] meshBinary)
    {
        using var input = new MemoryStream(meshBinary);
        var mesh = MeshBinarySerializer.Deserialize(input);

        var result = new VoxelizationService().Voxelize(mesh);

        using var output = new MemoryStream();
        VoxelizationResultBinarySerializer.Serialize(result, output);
        return output.ToArray();
    }
}