using System.Diagnostics;
using Solvix.Fem;
using Solvix.Contracts.Facades;

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
            var fine = input.Fine;
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

    private static SolverProblem BuildInput(SolverSetup setup, FemMeshDto mesh)
    {
        // every cube cut into nx*ny*nz small elements, as the solver's own mesh does
        var (nx, ny, nz) = setup.Divisions;
        var fine = FineMesh.Build(mesh, nx, ny, nz);

        var byName = setup.MaterialsByName.ToDictionary(m => m.Key, m => Material.Isotropic(m.Value.E, m.Value.Nu, m.Key));
        var materials = new Material[fine.ElementCount];
        for (int e = 0; e < fine.ElementCount; e++)
            materials[e] = byName[setup.MaterialOf(new ElementKey(mesh.ElementIds[fine.ParentOf[e]], fine.Ex[e], fine.Ey[e], fine.Ez[e]))];

        var cubeIndex = new Dictionary<int, int>();
        for (int e = 0; e < mesh.ElementCount; e++) cubeIndex[mesh.ElementIds[e]] = e;
        // a small face of a cube is the outward face of the one small element behind it
        ElementFace Face(SubFace f)
        {
            var (element, face) = fine.BoundaryElement(cubeIndex[f.Hex], f.Face, f.P, f.Q);
            return new ElementFace(element, face);
        }
        bool Known(SubFace f) => cubeIndex.ContainsKey(f.Hex) && SolverFaces.IsValid(f.Face);

        var loads = new LoadCase
        {
            Fixed = setup.Fixed.Where(Known).Select(Face).ToList(),
            // Pn is the solver's: along the outward normal, negative = compression
            Pressures = setup.Loads.Where(l => Known(l.Key)).Select(l => new FacePressure(Face(l.Key), l.Value)).ToList()
        };
        return new SolverProblem(fine, new FemModel(fine.Positions, fine.Connectivity, materials), loads);
    }
}

/// <summary>The divided mesh with its model and load case - what one solve works on.</summary>
internal sealed record SolverProblem(FineMesh Fine, FemModel Model, LoadCase Loads);
