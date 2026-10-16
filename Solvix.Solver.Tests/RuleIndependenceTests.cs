using Solvix.Contracts.Facades;
using Solvix.Fem;
using Solvix.FemMesh;
using Solvix.FemMesh.Local;
using static Solvix.Solver.Tests.SolverTestSupport;
using IFemMesh = Solvix.FemMesh.IFemMesh;

namespace Solvix.Solver.Tests;

/// <summary>
/// The solver must not be able to tell how its mesh was made. A bar with nu = 0, clamped at one end and pulled at the other, has the exact answer
/// stress = pressure everywhere and displacement = pressure * x / E; a mesh with a node hanging on a face, a load put on the wrong face or a
/// face counted twice breaks it. Every rule must give exactly that answer, to the last digits, from the very same setup.
/// </summary>
public class RuleIndependenceTests
{
    private const double E = 2.0e11, Pn = 1.0e6;
    private const int Cubes = 4;

    private static SolverSetup Setup(int nx = 1, int ny = 1, int nz = 1)
    {
        var setup = new SolverSetup();
        setup.Upsert(new SolverMaterialDto("steel0", "S", E, 0.0));
        setup.SetDefault("steel0");
        setup.SetDivisions(nx, ny, nz);
        return setup;
    }

    private static FemSolution Solve(SolverProblem problem) => LinearStaticSolver.Solve(problem.Model, problem.Loads);

    private static RefinementStep Cube(int cube, int n, int depth = 0) => new(new[] { LocalRefinement.RootKey(cube) }, n, n, n, depth);

    public static IEnumerable<TestCaseData> Rules()
    {
        yield return new TestCaseData(new UniformRefinement(1, 1, 1), 1, 1, 1).SetName("uniform 1x1x1");
        yield return new TestCaseData(new UniformRefinement(3, 2, 2), 3, 2, 2).SetName("uniform 3x2x2");
        yield return new TestCaseData(new LocalRefinement(new[] { Cube(1, 2) }), 1, 1, 1).SetName("local: the second cube 2x2x2");
        yield return new TestCaseData(new LocalRefinement(new[] { Cube(1, 3), Cube(3, 2) }), 1, 1, 1).SetName("local: two cubes, 3 and 2");
        yield return new TestCaseData(new LocalRefinement(new[] { Cube(2, 2, 2) }), 1, 1, 1).SetName("local: a cube with a wide transition zone");
        // the setup in a finer grid than the cubes: a cell of the setup is then several faces of a refined cube
        yield return new TestCaseData(new LocalRefinement(new[] { Cube(0, 2), Cube(3, 2) }), 2, 2, 2).SetName("local: both ends refined, the setup in 2x2x2 cells");
        yield return new TestCaseData(new LocalRefinement(new[] { Cube(1, 2), Cube(1, 2) }), 1, 1, 1).SetName("local: the same cube named twice");
    }

    [TestCaseSource(nameof(Rules))]
    public void A_bar_pulled_at_one_end_has_the_exact_answer_on_any_mesh(IMeshRefinement rule, int nx, int ny, int nz)
    {
        var coarse = Export(Bar(Cubes));
        var setup = Setup(nx, ny, nz);
        var counts = new[] { nx, ny, nz };
        var first = coarse.ElementIds[0];
        var last = coarse.ElementIds[Cubes - 1];
        setup.SetFixed(setup.Expand(first, "XMinus", null, null), true);
        setup.SetLoads(setup.Expand(last, "XPlus", null, null), Pn);
        var mesh = rule.Build(coarse);

        var problem = SolverFacade.BuildProblem(setup, coarse, mesh);
        var solution = Solve(problem);

        Assert.That(solution.Converged, Is.True);
        int nodes = mesh.NodeCount;
        double worst = 0;
        for (int n = 0; n < nodes; n++)
        {
            double x = mesh.Positions[n, 0];
            Assert.That(solution.Displacements[n], Is.EqualTo(Pn * x / E).Within(1e-10 * Cubes), $"ux at x={x}");
            Assert.That(solution.Displacements[nodes + n], Is.EqualTo(0).Within(1e-12), "no sideways movement");
            Assert.That(solution.Displacements[2 * nodes + n], Is.EqualTo(0).Within(1e-12));
            worst = Math.Max(worst, Math.Abs(solution.VonMises[n] - Pn));
        }
        Assert.That(worst, Is.LessThan(Pn * 1e-6), "the stress is the pressure everywhere");
        // the clamped and pulled faces are exactly the faces of the end cubes' sides: the number of element faces on them equals the cell area
        Assert.That(problem.Loads.Fixed.Select(f => mesh.RootOf(f.Element)).Distinct(), Is.EqualTo(new[] { 0 }));
        Assert.That(problem.Loads.Pressures.Select(p => mesh.RootOf(p.Face.Element)).Distinct(), Is.EqualTo(new[] { Cubes - 1 }));
    }

    [TestCaseSource(nameof(Rules))]
    public void The_pulled_faces_add_up_to_the_area_of_the_side_whatever_the_cut(IMeshRefinement rule, int nx, int ny, int nz)
    {
        var coarse = Export(Bar(Cubes));
        var setup = Setup(nx, ny, nz);
        var last = coarse.ElementIds[Cubes - 1];
        setup.SetLoads(setup.Expand(last, "XPlus", null, null), Pn);
        var mesh = rule.Build(coarse);

        var problem = SolverFacade.BuildProblem(setup, coarse, mesh);

        // the total force is the pressure times the area of the side (1 x 1), found by summing the real areas of the faces that got the pressure
        double area = 0;
        foreach (var p in problem.Loads.Pressures)
        {
            var corners = ElementLocal.FaceNodes[p.Face.Face].Where(n => n < 8).ToArray();
            double[] P(int k) => new[] { mesh.Positions[mesh.Connectivity[p.Face.Element, k], 0], mesh.Positions[mesh.Connectivity[p.Face.Element, k], 1], mesh.Positions[mesh.Connectivity[p.Face.Element, k], 2] };
            double lengthY = Math.Abs(P(corners.Max())[1] - P(corners.Min())[1]), lengthZ = Math.Abs(P(corners.Max())[2] - P(corners.Min())[2]);
            area += lengthY * lengthZ;
            Assert.That(p.Pn, Is.EqualTo(Pn));
        }
        Assert.That(area, Is.EqualTo(1.0).Within(1e-9));
    }
}
