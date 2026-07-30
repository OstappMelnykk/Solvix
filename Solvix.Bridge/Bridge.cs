using Solvix.Contracts.Facades;

namespace Solvix.Bridge;

public class Bridge
{
    private readonly IMeshBuilderFacade _meshBuilder;
    private readonly ISolverFacade _solver;

    public Bridge(IMeshBuilderFacade meshBuilder, ISolverFacade solver)
    {
        _meshBuilder = meshBuilder;
        _solver = solver;
    }
}