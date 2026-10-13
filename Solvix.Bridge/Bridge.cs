using Solvix.Contracts.Facades;

namespace Solvix.Bridge;

/// <summary>
/// The only place where the mesh editor and the solver meet (Mediator): the solver takes a plain mesh, the
/// editor gives one out, and neither knows the other exists.
/// </summary>
public class Bridge
{
    private readonly IMeshBuilderFacade _meshBuilder;
    private readonly ISolverFacade _solver;

    public Bridge(IMeshBuilderFacade meshBuilder, ISolverFacade solver)
    {
        _meshBuilder = meshBuilder;
        _solver = solver;
    }

    /// <summary>Checks the session's current mesh against its set-up (supports, loads, materials, folded cubes...).</summary>
    public SolverValidationDto Validate(int sessionId) => _solver.Validate(sessionId, _meshBuilder.ExportFemMesh(sessionId));

    /// <summary>The element quality of the session's current mesh at the current division.</summary>
    public SolverQualityReportDto Quality(int sessionId) => _solver.Quality(sessionId, _meshBuilder.ExportFemMesh(sessionId));

    /// <summary>Every standard's judgement of one small element of the session's current mesh.</summary>
    public SolverElementReportDto? QualityOfElement(int sessionId, int hex, int ex, int ey, int ez) => _solver.QualityOfElement(sessionId, _meshBuilder.ExportFemMesh(sessionId), hex, ex, ey, ez);

    /// <summary>Solves the session's current mesh in the background.</summary>
    public SolverJobDto StartSolve(int sessionId) => _solver.StartSolve(sessionId, _meshBuilder.ExportFemMesh(sessionId));
}
