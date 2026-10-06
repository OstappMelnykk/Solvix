using Microsoft.Extensions.DependencyInjection;
using Solvix.Contracts.Facades;

namespace Solvix.Solver;

public static class SolverServiceCollectionExtensions
{
    /// <summary>Registers the solver: per-session state (singleton) and the facade (scoped). Needs an <see cref="ISolverProgressNotifier"/> registered by the host to push progress.</summary>
    public static IServiceCollection AddSolver(this IServiceCollection services)
    {
        services.AddSingleton<SolverSessions>();
        services.AddScoped<ISolverFacade>(provider => new SolverFacade(provider.GetRequiredService<SolverSessions>(), provider.GetService<ISolverProgressNotifier>()));
        return services;
    }
}
