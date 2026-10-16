using Solvix.Contracts.Facades;
using Solvix.Mesh;

namespace Solvix.Solver.Tests;

internal static class SolverTestSupport
{
    /// <summary>A bar of unit cubes along X, as the editor builds it.</summary>
    public static HexMeshEditor Bar(int cubes)
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        for (int i = 1; i < cubes; i++) editor.AddHexOnFace(i - 1, HexFace.XPlus);
        return editor;
    }

    public static FemMeshDto Export(HexMeshEditor editor)
    {
        var fem = editor.Mesh.ToFemMesh();
        var positions = new double[fem.NodeCount * 3];
        for (int n = 0; n < fem.NodeCount; n++)
            for (int c = 0; c < 3; c++) positions[n * 3 + c] = fem.Positions[n, c];
        var connectivity = new int[fem.ElementCount * 20];
        for (int e = 0; e < fem.ElementCount; e++)
            for (int s = 0; s < 20; s++) connectivity[e * 20 + s] = fem.Connectivity[e, s];
        return new FemMeshDto(fem.NodeCount, fem.ElementCount, positions, connectivity, fem.NodeIds, fem.ElementIds, editor.Mesh.InvalidHexes(), fem.Cells);
    }

    public static ISolverFacade NewFacade() => new SolverFacade(new SolverSessions());

    /// <summary>Starts a solve and waits for it to leave the "running" state.</summary>
    public static SolverJobDto SolveAndWait(ISolverFacade facade, int session, FemMeshDto mesh, int timeoutSeconds = 120)
    {
        var job = facade.StartSolve(session, mesh);
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        while (job.State == "running" && DateTime.UtcNow < deadline)
        {
            Thread.Sleep(20);
            job = facade.GetJob(session);
        }
        return job;
    }
}
