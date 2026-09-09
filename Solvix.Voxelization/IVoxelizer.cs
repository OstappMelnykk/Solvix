namespace Solvix.Voxelization;

// Public abstraction for this project's sole entry point - MeshBuilderFacade
// depends on THIS, not the concrete Voxelizer, so it can be tested with a
// fake and so a future alternative implementation (caching decorator,
// different algorithm) can be substituted via AddVoxelization() without
// touching MeshBuilderFacade at all.
public interface IVoxelizer
{
    byte[] Voxelize(byte[] meshBinary, CancellationToken cancellationToken = default);
}