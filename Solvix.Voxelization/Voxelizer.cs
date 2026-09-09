namespace Solvix.Voxelization;

// Internal - callers (Solvix.MeshBuilder) depend on IVoxelizer, registered
// via AddVoxelization(), and never construct or name this concrete type.
// Sole implementation of this project's one public seam: everything about
// voxelization (the mesh/grid data shapes, both binary wire formats, the
// SAT/ray-parity algorithm itself) stays an internal implementation detail
// (see InternalsVisibleTo in the .csproj, which opens that up only to this
// project's own tests).
internal sealed class Voxelizer : IVoxelizer
{
    public byte[] Voxelize(byte[] meshBinary, CancellationToken cancellationToken = default)
    {
        using var input = new MemoryStream(meshBinary);
        var mesh = MeshBinarySerializer.Deserialize(input);

        var result = new VoxelizationService().Voxelize(mesh, cancellationToken);

        using var output = new MemoryStream();
        VoxelizationResultBinarySerializer.Serialize(result, output);
        return output.ToArray();
    }
}