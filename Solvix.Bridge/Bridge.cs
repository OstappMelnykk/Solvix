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

    /// <summary>The same for one element named by its key (the one thing that names an element of a mesh whatever made it).</summary>
    public SolverElementReportDto? QualityOfElementByKey(int sessionId, string key) => _solver.QualityOfElementByKey(sessionId, _meshBuilder.ExportFemMesh(sessionId), key);

    /// <summary>Refines the session's current mesh locally (the step is tried on the cubes first and refused if it cannot be done).</summary>
    public SolverSetupDto AddLocalRefinement(int sessionId, RefinementStepDto step) => _solver.AddLocalRefinement(sessionId, _meshBuilder.ExportFemMesh(sessionId), step);

    /// <summary>The mesh of finite elements of the session as it would be solved, with the materials, clamps and pressures on it.</summary>
    public SolverMeshDto GetMesh(int sessionId) => _solver.GetMesh(sessionId, _meshBuilder.ExportFemMesh(sessionId));

    /// <summary>Clamps, unclamps, presses or clears the pressure of exactly the faces of the mesh that were pointed at.</summary>
    public SolverSetupDto SelectFaces(int sessionId, IReadOnlyList<ElementFaceRefDto> faces, string action, double? pressure) =>
        _solver.SelectFaces(sessionId, _meshBuilder.ExportFemMesh(sessionId), faces, action, pressure);

    /// <summary>Gives exactly the elements of the mesh that were pointed at a material.</summary>
    public SolverSetupDto PaintElements(int sessionId, IReadOnlyList<string> elementKeys, string? material) =>
        _solver.PaintElements(sessionId, _meshBuilder.ExportFemMesh(sessionId), elementKeys, material);

    /// <summary>Solves the session's current mesh in the background.</summary>
    public SolverJobDto StartSolve(int sessionId) => _solver.StartSolve(sessionId, _meshBuilder.ExportFemMesh(sessionId));
}
