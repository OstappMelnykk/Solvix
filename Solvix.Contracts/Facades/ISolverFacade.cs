namespace Solvix.Contracts.Facades;

/// <summary>
/// The FEM solver as the rest of the app sees it. It knows nothing about the mesh editor: a mesh comes in as
/// plain arrays (<see cref="FemMeshDto"/>), set-up is kept per session, a solve runs in the background.
/// </summary>
public interface ISolverFacade
{
    SolverSetupDto GetSetup(int sessionId);

    /// <summary>Adds or replaces a material of the session's library by name.</summary>
    SolverSetupDto UpsertMaterial(int sessionId, SolverMaterialDto material);

    /// <summary>Gives cubes a material (an empty or null name returns them to the default one).</summary>
    SolverSetupDto SetHexMaterial(int sessionId, IReadOnlyList<int> hexIds, string? material);

    SolverSetupDto SetDefaultMaterial(int sessionId, string material);

    /// <summary>Fixes (or frees) faces: every node on a fixed face is clamped.</summary>
    SolverSetupDto SetFixedFaces(int sessionId, IReadOnlyList<SolverFaceDto> faces, bool fixedFaces);

    /// <summary>Sets a uniform pressure on faces (null removes it).</summary>
    SolverSetupDto SetLoads(int sessionId, IReadOnlyList<SolverFaceDto> faces, double? pressure);

    /// <summary>Forgets everything set so far (supports, loads, per-cube materials).</summary>
    SolverSetupDto ClearSetup(int sessionId);

    /// <summary>Drops the supports, loads and materials of cubes that no longer exist.</summary>
    SolverSetupDto Prune(int sessionId, IReadOnlyCollection<int> existingHexes);

    SolverValidationDto Validate(int sessionId, FemMeshDto mesh);

    /// <summary>Starts a solve in the background; if one is running, that one is reported instead.</summary>
    SolverJobDto StartSolve(int sessionId, FemMeshDto mesh);

    SolverJobDto GetJob(int sessionId);

    SolverJobDto CancelSolve(int sessionId);

    SolverResultDto? GetResult(int sessionId);

    void DropSession(int sessionId);
}

/// <summary>Pushes the progress of a background solve to whoever listens (SignalR in the API).</summary>
public interface ISolverProgressNotifier
{
    Task JobChanged(int sessionId, SolverJobDto job);
}
