using Solvix.Contracts.Facades;
using Solvix.Voxelization;

namespace Solvix.MeshBuilder;

// Facade (GoF): exposes a simplified, stable surface to callers
// (Solvix.Api) - callers depend only on IMeshBuilderFacade, never on
// Voxelizer or any future subsystem directly. Subsystems are DI services
// like everything else in the composition root, not manually `new`'d
// here.
public class MeshBuilderFacade(Voxelizer voxelizer) : IMeshBuilderFacade
{
    public byte[] Voxelize(byte[] meshBinary)
    {
        // Translates Solvix.Voxelization's own error type into MeshBuilder's
        // - Solvix.Api should never need to know Solvix.Voxelization exists,
        // even just to catch its exception type.
        try
        {
            return voxelizer.Voxelize(meshBinary);
        }
        catch (VoxelizationTooLargeException error)
        {
            throw new MeshTooLargeException(error.CellCount, error.Limit);
        }
    }
}