using Solvix.Contracts.Facades;
using Solvix.Voxelization;

namespace Solvix.MeshBuilder;

// Facade (GoF): exposes a simplified, stable surface to callers
// (Solvix.Api) - callers depend only on IMeshBuilderFacade (defined in
// Solvix.Contracts), never on this concrete class or IVoxelizer/Voxelizer
// directly. Internal - only AddMeshBuilder() ever names this type; Api
// resolves it purely through the interface, same reasoning as Voxelizer
// being internal to Solvix.Voxelization.
internal sealed class MeshBuilderFacade(IVoxelizer voxelizer) : IMeshBuilderFacade
{
    /// <param name="meshBinary">
    /// Passed straight through to <see cref="IVoxelizer.Voxelize"/> unopened
    /// - this method never inspects the bytes itself, only the exceptions
    /// that come back out of parsing/processing them.
    /// </param>
    /// <param name="cancellationToken">Forwarded unchanged to <see cref="IVoxelizer.Voxelize"/>.</param>
    /// <returns>The voxel grid bytes <see cref="IVoxelizer.Voxelize"/> produced, forwarded unchanged.</returns>
    public byte[] Voxelize(byte[] meshBinary, CancellationToken cancellationToken)
    {
        // Translates Solvix.Voxelization's own error types into
        // MeshBuilder's - Solvix.Api should never need to know
        // Solvix.Voxelization exists, even just to catch its exception
        // types.
        try
        {
            return voxelizer.Voxelize(meshBinary, cancellationToken);
        }
        catch (VoxelizationTooLargeException error)
        {
            throw new MeshTooLargeException(error.CellCount, error.Limit);
        }
        catch (MalformedMeshException error)
        {
            throw new InvalidMeshException(error.Message);
        }
    }
}