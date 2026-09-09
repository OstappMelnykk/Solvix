using Microsoft.Extensions.DependencyInjection;

namespace Solvix.Voxelization;

public static class VoxelizationServiceCollectionExtensions
{
    // Registers this project's one public seam - callers (Solvix.MeshBuilder)
    // never need to name the concrete Voxelizer type themselves, matching
    // the same "AddXyz() hides the implementation" shape as
    // Solvix.MeshBuilder.MeshBuilderServiceCollectionExtensions.AddMeshBuilder().
    public static IServiceCollection AddVoxelization(this IServiceCollection services)
    {
        services.AddSingleton<IVoxelizer, Voxelizer>();
        return services;
    }
}