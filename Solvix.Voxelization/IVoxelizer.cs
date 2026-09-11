namespace Solvix.Voxelization;

// Public abstraction for this project's sole entry point - MeshBuilderFacade
// depends on THIS, not the concrete Voxelizer, so it can be tested with a
// fake and so a future alternative implementation (caching decorator,
// different algorithm) can be substituted via AddVoxelization() without
// touching MeshBuilderFacade at all.
public interface IVoxelizer
{
    /// <param name="meshBinary">
    /// The triangle mesh to voxelize, in this project's binary wire format
    /// (see <see cref="MeshBinarySerializer"/> for the exact byte layout).
    /// Deserialized internally into an <see cref="ImportedSurfaceMesh"/>
    /// before anything else happens to it.
    /// </param>
    /// <param name="cancellationToken">
    /// Checked inside <see cref="VoxelizationService"/>'s per-cell loop so a
    /// large voxelization can actually stop early instead of running to
    /// completion after the caller has given up.
    /// </param>
    /// <returns>
    /// The resulting <see cref="VoxelizationResult"/> (uniform grid +
    /// occupancy bitmask), serialized via
    /// <see cref="VoxelizationResultBinarySerializer"/>.
    /// </returns>
    byte[] Voxelize(byte[] meshBinary, CancellationToken cancellationToken = default);
}