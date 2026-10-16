using System.Diagnostics;
using Solvix.Fem;
using Solvix.Contracts.Facades;
using IFemMesh = Solvix.FemMesh.IFemMesh;

namespace Solvix.Solver;

// Facade (GoF): the only way in - callers use ISolverFacade (Solvix.Contracts), never the solver itself.
internal sealed class SolverFacade(SolverSessions sessions, ISolverProgressNotifier? notifier = null) : ISolverFacade
{
    public SolverSetupDto GetSetup(int sessionId) => sessions.With(sessionId, s => s.Setup.ToDto());

    public SolverSetupDto UpsertMaterial(int sessionId, SolverMaterialDto material) => sessions.With(sessionId, s =>
    {
        var problem = Materials.Problem(material);
        if (problem is null) s.Setup.Upsert(material);
        return s.Setup.ToDto();
    });

    public SolverSetupDto RemoveMaterial(int sessionId, string name) => sessions.With(sessionId, s =>
    {
        s.Setup.Remove(name);
        return s.Setup.ToDto();
    });

    public SolverSetupDto SetHexMaterial(int sessionId, IReadOnlyList<int> hexIds, string? material) => sessions.With(sessionId, s =>
    {
        if (string.IsNullOrEmpty(material) || s.Setup.MaterialsByName.ContainsKey(material)) s.Setup.SetMaterial(hexIds, material);
        return s.Setup.ToDto();
    });

    public SolverSetupDto SetDefaultMaterial(int sessionId, string material) => sessions.With(sessionId, s =>
    {
        if (s.Setup.MaterialsByName.ContainsKey(material)) s.Setup.SetDefault(material);
        return s.Setup.ToDto();
    });

    public SolverSetupDto SetDivisions(int sessionId, int nx, int ny, int nz) => sessions.With(sessionId, s =>
    {
        s.Setup.SetDivisions(nx, ny, nz);
        return s.Setup.ToDto();
    });

    // the small faces a list of requests names: a request without (p, q) means the whole side of the cube
    private static IEnumerable<SubFace> SubFaces(SolverSetup setup, IReadOnlyList<SolverFaceDto> faces) =>
        faces.Where(f => SolverFaces.IsValid(f.Face)).SelectMany(f => setup.Expand(f.Hex, f.Face, f.P, f.Q));

    public SolverSetupDto ReplaceFixedFaces(int sessionId, IReadOnlyList<SolverFaceDto> faces) => sessions.With(sessionId, s =>
    {
        s.Setup.ReplaceFixed(SubFaces(s.Setup, faces));
        return s.Setup.ToDto();
    });

    public SolverSetupDto ReplaceLoads(int sessionId, IReadOnlyList<SolverFaceDto> faces, double pressure) => sessions.With(sessionId, s =>
    {
        if (double.IsFinite(pressure)) s.Setup.ReplaceLoads(SubFaces(s.Setup, faces), pressure);
        return s.Setup.ToDto();
    });

    public SolverSetupDto SetFixedFaces(int sessionId, IReadOnlyList<SolverFaceDto> faces, bool fixedFaces) => sessions.With(sessionId, s =>
    {
        s.Setup.SetFixed(SubFaces(s.Setup, faces), fixedFaces);
        return s.Setup.ToDto();
    });

    public SolverSetupDto SetLoads(int sessionId, IReadOnlyList<SolverFaceDto> faces, double? pressure) => sessions.With(sessionId, s =>
    {
        if (pressure is null || double.IsFinite(pressure.Value))
            s.Setup.SetLoads(SubFaces(s.Setup, faces), pressure);
        return s.Setup.ToDto();
    });

    public SolverSetupDto SetElementMaterial(int sessionId, IReadOnlyList<SolverElementDto> elements, string? material) => sessions.With(sessionId, s =>
    {
        if (string.IsNullOrEmpty(material) || s.Setup.MaterialsByName.ContainsKey(material))
            s.Setup.SetElementMaterial(elements.Select(e => new ElementKey(e.Hex, e.Ex, e.Ey, e.Ez)), material);
        return s.Setup.ToDto();
    });

    public SolverSetupDto UndoSetup(int sessionId) => sessions.With(sessionId, s =>
    {
        s.Setup.Undo();
        return s.Setup.ToDto();
    });

    public SolverSetupDto RedoSetup(int sessionId) => sessions.With(sessionId, s =>
    {
        s.Setup.Redo();
        return s.Setup.ToDto();
    });

    public SolverSetupDto ClearSetup(int sessionId) => sessions.With(sessionId, s =>
    {
        s.Setup.Clear();
        s.Result = null;
        return s.Setup.ToDto();
    });

    public SolverSetupDto Prune(int sessionId, IReadOnlyCollection<int> existingHexes) => sessions.With(sessionId, s =>
    {
        s.Setup.Prune(existingHexes);
        return s.Setup.ToDto();
    });

    public SolverElementReportDto? QualityOfElement(int sessionId, FemMeshDto mesh, int hex, int ex, int ey, int ez) =>
        sessions.With(sessionId, s => MeshQuality.OfElement(s.Setup, mesh, hex, ex, ey, ez));

    public SolverQualityReportDto Quality(int sessionId, FemMeshDto mesh) => sessions.With(sessionId, s => MeshQuality.Evaluate(s.Setup, mesh));

    public SolverValidationDto Validate(int sessionId, FemMeshDto mesh) => sessions.With(sessionId, s => SolverValidator.Validate(s.Setup, mesh));

    public SolverJobDto StartSolve(int sessionId, FemMeshDto mesh) => sessions.With(sessionId, s =>
    {
        if (s.Job.State == "running") return s.Job;
        var validation = SolverValidator.Validate(s.Setup, mesh);
        if (!validation.CanSolve)
            return s.Job = new SolverJobDto("failed", 0, "", string.Join(" ", validation.Issues.Where(i => i.Severity == "error").Select(i => i.Message)), s.Ticket);

        var input = BuildInput(s.Setup, mesh);
        int ticket = ++s.Ticket;
        var cts = s.Cancel = new CancellationTokenSource();
        s.Job = new SolverJobDto("running", 0, "Підготовка", null, ticket);
        var token = cts.Token;
        _ = Task.Run(() => Run(sessionId, mesh, input, ticket, token));
        return s.Job;
    });

    public SolverJobDto GetJob(int sessionId) => sessions.With(sessionId, s => s.Job);

    public SolverJobDto CancelSolve(int sessionId) => sessions.With(sessionId, s =>
    {
        if (s.Job.State == "running") s.Cancel?.Cancel();
        return s.Job;
    });

    public SolverResultDto? GetResult(int sessionId) => sessions.With(sessionId, s => s.Result);

    public void DropSession(int sessionId) => sessions.Remove(sessionId);

    // ---- the background run -----------------------------------------------------------------

    private void Run(int sessionId, FemMeshDto mesh, SolverProblem input, int ticket, CancellationToken cancel)
    {
        var clock = Stopwatch.StartNew();
        double lastReported = -1;
        void Report(double progress, string stage)
        {
            if (progress - lastReported < 0.01 && progress < 1) return;
            lastReported = progress;
            Publish(sessionId, ticket, new SolverJobDto("running", progress, stage, null, ticket));
        }
        try
        {
            var output = LinearStaticSolver.Solve(input.Model, input.Loads, Report, cancel);
            if (!output.Converged)
            {
                Publish(sessionId, ticket, new SolverJobDto("failed", 1, "", $"Ітерації не збіглися (нев'язка {output.Residual:E1}): система погано обумовлена, спробуйте менший контраст матеріалів або менше кубів.", ticket));
                return;
            }
            var fine = input.Fine ?? throw new NotSupportedException("The result of a mesh that is not cut evenly cannot be shown yet.");
            int n = fine.NodeCount;
            var ux = new double[n]; var uy = new double[n]; var uz = new double[n]; var positions = new double[3 * n];
            for (int i = 0; i < n; i++)
            {
                ux[i] = output.Displacements[i]; uy[i] = output.Displacements[n + i]; uz[i] = output.Displacements[2 * n + i];
                for (int c = 0; c < 3; c++) positions[3 * i + c] = fine.Positions[i, c];
            }
            double maxDisplacement = Enumerable.Range(0, n).Max(i => Math.Sqrt(ux[i] * ux[i] + uy[i] * uy[i] + uz[i] * uz[i]));
            var result = new SolverResultDto(ticket, new[] { fine.Divisions.Nx, fine.Divisions.Ny, fine.Divisions.Nz }, positions, mesh.ElementIds, fine.GridNodes,
                ux, uy, uz, output.VonMises, maxDisplacement, output.VonMises.Max(), clock.Elapsed.TotalSeconds);
            sessions.With(sessionId, s =>
            {
                if (s.Ticket == ticket) s.Result = result;
                return 0;
            });
            Publish(sessionId, ticket, new SolverJobDto("done", 1, "Готово", null, ticket));
        }
        catch (OperationCanceledException)
        {
            Publish(sessionId, ticket, new SolverJobDto("cancelled", 0, "", null, ticket));
        }
        catch (Exception exception)
        {
            Publish(sessionId, ticket, new SolverJobDto("failed", 0, "", exception.Message, ticket));
        }
    }

    // A late message of an old run never overwrites a newer one.
    private void Publish(int sessionId, int ticket, SolverJobDto job)
    {
        bool current = sessions.With(sessionId, s =>
        {
            if (s.Ticket != ticket) return false;
            s.Job = job;
            return true;
        });
        if (current && notifier is not null) _ = notifier.JobChanged(sessionId, job);
    }

    // ---- set-up + mesh -> solver input ------------------------------------------------------

    internal static SolverProblem BuildInput(SolverSetup setup, FemMeshDto mesh)
    {
        // every cube cut into nx*ny*nz small elements, as the solver's own mesh does
        var (nx, ny, nz) = setup.Divisions;
        var fine = FineMesh.Build(mesh, nx, ny, nz);

        // From here on the solver works on the mesh of finite elements (IFemMesh): the setup's cells are bound to its elements and faces by
        // SetupBinding, and nothing below asks which cube an element came from or how it was cut.
        return BuildProblem(setup, mesh, fine.Mesh, fine);
    }

    /// <summary>
    /// The solver's input on ANY mesh of finite elements: what the setup says (materials, clamps, pressures, set on regions of the cubes) is bound to the
    /// elements and faces of the mesh, whatever rule made it. The grid the setup is spoken of in plays no part here: a region is a place in the cube, and the
    /// faces and elements of the mesh whose centres lie in it are what it means.
    /// </summary>
    internal static SolverProblem BuildProblem(SolverSetup setup, FemMeshDto mesh, IFemMesh femMesh, FineMesh? fine = null)
    {
        var byName = setup.MaterialsByName.ToDictionary(m => m.Key, m => Material.Isotropic(m.Value.E, m.Value.Nu, m.Key));
        var materials = new Material[femMesh.ElementCount];
        for (int e = 0; e < femMesh.ElementCount; e++)
            materials[e] = byName[setup.MaterialAt(mesh.ElementIds[femMesh.RootOf(e)], femMesh.CentreOf(e))];

        var clamped = new HashSet<ElementFace>();
        var pressures = new List<FacePressure>();
        for (int cube = 0; cube < mesh.ElementCount; cube++)
        {
            int hex = mesh.ElementIds[cube];
            foreach (var side in SolverFaces.Names)
            {
                bool anyFixed = setup.HasFixed(hex, side), anyLoad = setup.HasLoads(hex, side);
                if (!anyFixed && !anyLoad) continue;
                foreach (var face in femMesh.FacesOnSide(cube, side))
                {
                    var at = femMesh.FaceCentreOf(face);
                    var solverFace = new ElementFace(face.Element, face.Face);
                    if (anyFixed && setup.IsFixedAt(hex, side, at)) clamped.Add(solverFace);
                    // Pn is the solver's: along the outward normal, negative = compression
                    if (anyLoad && setup.LoadAt(hex, side, at) is double pn) pressures.Add(new FacePressure(solverFace, pn));
                }
            }
        }
        var loads = new LoadCase { Fixed = clamped.ToList(), Pressures = pressures };
        return new SolverProblem(femMesh, fine, new FemModel(femMesh.Positions, femMesh.Connectivity, materials), loads);
    }
}

/// <summary>The divided mesh with its model and load case - what one solve works on.</summary>
internal sealed record SolverProblem(IFemMesh Mesh, FineMesh? Fine, FemModel Model, LoadCase Loads);
