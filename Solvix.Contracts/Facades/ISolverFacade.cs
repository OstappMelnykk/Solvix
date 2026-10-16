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

    /// <summary>Removes a material from the library; what had it returns to the default material. The default material stays.</summary>
    SolverSetupDto RemoveMaterial(int sessionId, string name);

    /// <summary>Gives cubes a material (an empty or null name returns them to the default one).</summary>
    SolverSetupDto SetHexMaterial(int sessionId, IReadOnlyList<int> hexIds, string? material);

    /// <summary>Gives small elements of a divided cube a material of their own (an empty or null name makes them follow their cube again).</summary>
    SolverSetupDto SetElementMaterial(int sessionId, IReadOnlyList<SolverElementDto> elements, string? material);

    SolverSetupDto SetDefaultMaterial(int sessionId, string material);

    /// <summary>How many small elements each cube is cut into along its axes (1..8 each), as the solver's Nx, Ny, Nz; invalid values change nothing.</summary>
    SolverSetupDto SetDivisions(int sessionId, int nx, int ny, int nz);

    /// <summary>
    /// Refines locally: the leaves of the step (keys as the mesh gives them) are cut into NI x NJ x NK, the cells round them by transition templates. The step is tried on the cubes
    /// first and refused (<see cref="ArgumentException"/>) if it cannot be done. The even cut gives way to it.
    /// </summary>
    SolverSetupDto AddLocalRefinement(int sessionId, FemMeshDto mesh, RefinementStepDto step);

    /// <summary>Takes the whole local refinement away (the cubes are cut evenly by the division again).</summary>
    SolverSetupDto ClearLocalRefinement(int sessionId);

    /// <summary>The mesh of finite elements as it would be solved, with the materials, clamps and pressures that are on it.</summary>
    SolverMeshDto GetMesh(int sessionId, FemMeshDto mesh);

    /// <summary>
    /// Clamps (<paramref name="action"/> "fix"), unclamps ("unfix"), presses ("load", with <paramref name="pressure"/>) or clears the pressure ("unload") of exactly these faces of the mesh
    /// - the faces the user pointed at, not the faces of the cube behind them. Faces that are not on a side of a cube, or that the mesh does not have, are ignored.
    /// </summary>
    SolverSetupDto SelectFaces(int sessionId, FemMeshDto mesh, IReadOnlyList<ElementFaceRefDto> faces, string action, double? pressure);

    /// <summary>Gives exactly these elements of the mesh a material (an empty or null name makes them follow their cube again).</summary>
    SolverSetupDto PaintElements(int sessionId, FemMeshDto mesh, IReadOnlyList<string> elementKeys, string? material);

    /// <summary>Makes exactly these faces the clamped ones (a side picked as a whole replaces what was clamped before).</summary>
    SolverSetupDto ReplaceFixedFaces(int sessionId, IReadOnlyList<SolverFaceDto> faces);

    /// <summary>Makes exactly these faces carry the pressure (replacing every pressure set before).</summary>
    SolverSetupDto ReplaceLoads(int sessionId, IReadOnlyList<SolverFaceDto> faces, double pressure);

    /// <summary>Fixes (or frees) faces: every node on a fixed face is clamped.</summary>
    SolverSetupDto SetFixedFaces(int sessionId, IReadOnlyList<SolverFaceDto> faces, bool fixedFaces);

    /// <summary>Sets a uniform pressure on faces (null removes it).</summary>
    SolverSetupDto SetLoads(int sessionId, IReadOnlyList<SolverFaceDto> faces, double? pressure);

    /// <summary>Forgets everything set so far (supports, loads, per-cube materials).</summary>
    SolverSetupDto ClearSetup(int sessionId);

    /// <summary>Takes back the last change of the set-up (supports, pressures, materials, division); does nothing when there is none.</summary>
    SolverSetupDto UndoSetup(int sessionId);

    SolverSetupDto RedoSetup(int sessionId);

    /// <summary>Drops the supports, loads and materials of cubes that no longer exist.</summary>
    SolverSetupDto Prune(int sessionId, IReadOnlyCollection<int> existingHexes);

    /// <summary>The element quality of the mesh as it would be solved (per cube and overall).</summary>
    SolverQualityReportDto Quality(int sessionId, FemMeshDto mesh);

    /// <summary>Every standard's judgement of one small element of the mesh (null when there is no such element).</summary>
    SolverElementReportDto? QualityOfElement(int sessionId, FemMeshDto mesh, int hex, int ex, int ey, int ez);

    /// <summary>The same for one element named by its key.</summary>
    SolverElementReportDto? QualityOfElementByKey(int sessionId, FemMeshDto mesh, string key);

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
