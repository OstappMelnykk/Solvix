namespace Solvix.Contracts.Facades;

public interface IMeshBuilderFacade
{
    // Bytes in, bytes out - the wire format on both sides (and everything
    // about how voxelization actually works) is Solvix.MeshBuilder's own
    // business; Contracts and Solvix.Api never need to know the shape of
    // either side. Throws Solvix.MeshBuilder.MeshTooLargeException when
    // the mesh is scaled too large relative to the unit cube, or
    // Solvix.MeshBuilder.InvalidMeshException when the mesh body itself is
    // malformed. `cancellationToken` lets a long voxelization for a large
    // mesh actually stop early if the caller (an HTTP request) is aborted,
    // rather than running a CPU-bound computation to completion for
    // nobody.
    byte[] Voxelize(byte[] meshBinary, CancellationToken cancellationToken);
}