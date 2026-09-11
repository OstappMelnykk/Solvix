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
    /// <param name="meshBinary">
    /// The triangle mesh to voxelize, encoded in the binary wire format
    /// shared with the frontend's <c>toMeshBinary</c> (mesh-contract.ts):
    /// [uint32 vertexCount][uint32 indexCount][vertexCount×3 float32
    /// x,y,z][indexCount×uint32]. Vertices are already in the exact world
    /// coordinates/scale the caller wants voxelized - this method never
    /// rescales them itself.
    /// </param>
    /// <param name="cancellationToken">
    /// Lets an in-progress voxelization stop early if the caller (an HTTP
    /// request in practice) is aborted, instead of finishing a CPU-bound
    /// computation nobody will read the result of.
    /// </param>
    /// <returns>
    /// The resulting uniform voxel grid, encoded in the binary wire format
    /// shared with the frontend's <c>VoxelGridDto</c> decoder
    /// (voxel-grid-contract.ts): origin, cell size, grid dimensions, and an
    /// occupancy bitmask (one bit per cell).
    /// </returns>
    byte[] Voxelize(byte[] meshBinary, CancellationToken cancellationToken);
}