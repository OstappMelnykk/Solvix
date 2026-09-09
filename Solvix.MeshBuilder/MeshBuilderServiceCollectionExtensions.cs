using Microsoft.Extensions.DependencyInjection;
using Solvix.Contracts.Facades;
using Solvix.Voxelization;

namespace Solvix.MeshBuilder;

public static class MeshBuilderServiceCollectionExtensions
{
    // Everything mesh-building related, registered in one place so the
    // composition root (Program.cs) doesn't need to know this project's
    // internal service shape - only that "mesh building" is available.
    public static IServiceCollection AddMeshBuilder(this IServiceCollection services)
    {
        services.AddVoxelization();
        services.AddScoped<IMeshBuilderFacade, MeshBuilderFacade>();
        return services;
    }
}