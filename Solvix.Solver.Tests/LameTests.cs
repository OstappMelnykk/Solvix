using Solvix.Contracts.Facades;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

// A body of many curved cubes against closed-form answers: a thick-walled pipe (inner radius 1, outer 2) clamped at
// both ends, solved in the middle where it behaves like plane strain.
public class LameTests
{
    private const int Session = 1;
    private const double Centre = 6, A = 1, B = 2, P = 1e6, E = 2.1e11, Nu = 0.3;

    private static (HexMeshEditor Editor, SolverResultDto Result) Solve(bool outsideToo, int division)
    {
        var editor = new HexMeshEditor();
        editor.AddBody(HexTemplates.Kind("pipe").Build(new Dictionary<string, double>
        { ["around"] = 12, ["wallCells"] = 2, ["along"] = 6, ["radiusX"] = 2, ["radiusZ"] = 2, ["wall"] = 1, ["height"] = 12 }));
        var facade = NewFacade();
        facade.SetDivisions(Session, division, 1, division);
        var ends = editor.Mesh.Hexes.Where(h => h.Cell.J == 0).Select(h => new SolverFaceDto(h.Id, "YMinus"))
            .Concat(editor.Mesh.Hexes.Where(h => h.Cell.J == 5).Select(h => new SolverFaceDto(h.Id, "YPlus"))).ToList();
        facade.SetFixedFaces(Session, ends, true);
        var loaded = new List<SolverFaceDto>();
        foreach (var hex in editor.Mesh.Hexes)
            foreach (var f in new[] { HexFace.XMinus, HexFace.XPlus, HexFace.ZMinus, HexFace.ZPlus })
            {
                if (editor.Mesh.Neighbor(hex.Id, f) is not null) continue;
                var c = f.Slots().Select(s => editor.Mesh.Node(hex.NodeIds[s]).Position).Aggregate(Vec3.Zero, (acc, v) => acc + v) * (1.0 / 8);
                double r = Math.Sqrt(Math.Pow(c.X - Centre, 2) + Math.Pow(c.Z - Centre, 2));
                if (r < 1.5 || outsideToo) loaded.Add(new SolverFaceDto(hex.Id, f.ToString()));
            }
        facade.SetLoads(Session, loaded, -P);
        var job = SolveAndWait(facade, Session, Export(editor));
        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        return (editor, facade.GetResult(Session)!);
    }

    private static IEnumerable<(double Radius, double Angle, double Radial)> MiddleNodes(SolverResultDto r, double radius) =>
        Enumerable.Range(0, r.Ux.Count)
            .Where(i => Math.Abs(r.Positions[3 * i + 1] - 6) < 1e-6)
            .Select(i =>
            {
                double dx = r.Positions[3 * i] - Centre, dz = r.Positions[3 * i + 2] - Centre, rr = Math.Sqrt(dx * dx + dz * dz);
                return (Radius: rr, Angle: ((Math.Atan2(dz, dx) * 180 / Math.PI % 90) + 90) % 90, Radial: (r.Ux[i] * dx + r.Uz[i] * dz) / rr);
            })
            .Where(n => Math.Abs(n.Radius - radius) < 0.08);

    [Test]
    public void A_pipe_under_internal_pressure_expands_as_Lame_says_all_the_way_round()
    {
        var (_, result) = Solve(outsideToo: false, division: 1);

        double expected = (1 + Nu) * P * A / E * ((1 - 2 * Nu) * A * A + B * B) / (B * B - A * A);        // plane strain
        var inner = MiddleNodes(result, A).ToList();

        Assert.That(inner.Count, Is.GreaterThan(30));
        Assert.That(inner.Average(n => n.Radial), Is.EqualTo(expected).Within(expected * 0.03));
        // the same at the flats of the lattice ring and at its corners: the answer must not depend on the direction
        Assert.That(inner.Max(n => n.Radial) - inner.Min(n => n.Radial), Is.LessThan(expected * 0.03));
    }

    [Test]
    public void The_division_does_not_change_the_answer_of_the_curved_pipe_much()
    {
        var coarse = MiddleNodes(Solve(false, 1).Result, A).Average(n => n.Radial);
        var fine = MiddleNodes(Solve(false, 2).Result, A).Average(n => n.Radial);

        Assert.That(fine, Is.EqualTo(coarse).Within(coarse * 0.02));
    }

    [Test]
    public void Equal_pressure_inside_and_out_squeezes_the_pipe_uniformly()
    {
        // hydrostatic: the state is constant, which any valid mesh must reproduce exactly (the patch test, through a full solve)
        var (_, result) = Solve(outsideToo: true, division: 1);

        double expected = -(1 + Nu) * (1 - 2 * Nu) * P * A / E;                                  // plane strain, uniform strain in the section
        var inner = MiddleNodes(result, A).ToList();
        var outer = MiddleNodes(result, B).ToList();

        Assert.That(inner.Average(n => n.Radial), Is.EqualTo(expected).Within(Math.Abs(expected) * 0.03));
        Assert.That(outer.Average(n => n.Radial), Is.EqualTo(2 * expected).Within(Math.Abs(expected) * 0.06));   // u grows with the radius
        Assert.That(inner.Max(n => n.Radial) - inner.Min(n => n.Radial), Is.LessThan(Math.Abs(expected) * 0.03));
    }
}
