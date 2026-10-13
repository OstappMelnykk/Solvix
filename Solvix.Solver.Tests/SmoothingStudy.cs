using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using NUnit.Framework;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>
/// The measurements behind docs/research/mesh-smoothing (every table there comes from here). It is slow, so it is skipped
/// unless the environment variable SOLVIX_STUDY is set: SOLVIX_STUDY=1 dotnet test --filter SmoothingStudy. It writes the
/// tables to /tmp/solvix-smoothing-study.md as it goes.
/// </summary>
[Explicit("a long measurement, not a check: run it by name")]
public class SmoothingStudy
{
    private const string Output = "/tmp/solvix-smoothing-study.md";
    private static readonly CultureInfo C = CultureInfo.InvariantCulture;

    private static void Line(string text) => File.AppendAllText(Output, text + "\n");

    private record Snap(int Folded, int Bad, int Elements, double ScaledJ, double MinAngle, double MaxAngle, double Skew, double JacRatio, double CubeQ);

    private static double CubeQ(HexMesh mesh) => mesh.Hexes.Min(h => { var (a, b) = h.DeterminantRange(); return a <= 1e-9 ? a : a / b; });

    private static Snap Measure(HexMeshEditor editor)
    {
        var q = NewFacade().Quality(1, Export(editor)).Profiles.Single(p => p.Id == "solvix");
        return new Snap(editor.Mesh.InvalidHexes().Count, q.Grades.GetValueOrDefault("poor") + q.Grades.GetValueOrDefault("invalid"), q.Elements,
            q.Worst["scaledJacobian"], q.Worst["minCornerAngle"], q.Worst["maxCornerAngle"], q.Worst["equiangleSkew"], q.Worst["jacobianRatio"], CubeQ(editor.Mesh));
    }

    private static string Row(Snap s) =>
        $"{s.Folded} | {s.Bad}/{s.Elements} | {s.ScaledJ.ToString("0.00", C)} | {s.MinAngle.ToString("0.0", C)}° | {s.MaxAngle.ToString("0.0", C)}° | {s.Skew.ToString("0.00", C)} | {(s.JacRatio >= 1e6 ? "∞" : s.JacRatio.ToString("0.0", C))} | {s.CubeQ.ToString("0.00", C)}";

    private const string Header = "| fold | bad | min scaledJ | min angle | max angle | skew | Jacobian ratio | worst cube Q |\n|---|---|---|---|---|---|---|---|";

    private static HexMeshEditor Rough(int n, double jitter, int seed)
    {
        var e = new HexMeshEditor();
        e.AddBody(HexTemplates.Kind("rough-block").Build(new Dictionary<string, double> { ["countX"] = n, ["countY"] = n, ["countZ"] = n, ["length"] = n, ["height"] = n, ["depth"] = n, ["jitter"] = jitter, ["seed"] = seed }));
        return e;
    }

    [Test]
    public void Run_everything()
    {
        File.WriteAllText(Output, "# raw tables of the smoothing study\n\n");
        A_rough_blocks();
        B_ready_made_bodies();
        C_the_users_mesh();
        D_density();
        E_convergence();
        F_speed();
        G_stress();
    }

    private static void A_rough_blocks()
    {
        Line("## A. Shaken blocks (the `rough-block` template), settings: 100 passes, step 0.5, density 100%\n");
        Line("| cubes | shake | state | " + Header.Split('\n')[0].Substring(2) + "\n|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (int n in new[] { 4, 6, 8 })
            foreach (double jitter in new[] { 0.1, 0.2, 0.25 })
            {
                var e = Rough(n, jitter, 3);
                Line($"| {n * n * n} | {jitter.ToString(C)} | before | {Row(Measure(e))} |");
                e.Smooth(100, 0.5);
                Line($"| {n * n * n} | {jitter.ToString(C)} | after | {Row(Measure(e))} |");
            }
        Line("");
    }

    private static void B_ready_made_bodies()
    {
        Line("## B. The ready-made bodies of the library: interior only, then with the surface (feature angle 60), 100 passes\n");
        Line("| body | cubes | run | ms | " + Header.Split('\n')[0].Substring(2) + "\n|---|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (var preset in HexTemplates.Presets)
        {
            HexMeshEditor Fresh() { var e = new HexMeshEditor(); e.AddBody(HexTemplates.Kind(preset.Kind).Build(preset.Values)); return e; }
            var plain = Fresh();
            Line($"| {preset.Name} | {plain.Mesh.Hexes.Count} | before | | {Row(Measure(plain))} |");
            var clock = Stopwatch.StartNew();
            var r = plain.Smooth(100, 0.5);
            long ms = clock.ElapsedMilliseconds;
            Line($"| | | interior {(r.Ok ? "" : "(nothing to do)")} | {ms} | {Row(Measure(plain))} |");
            var surf = Fresh();
            clock.Restart();
            var r2 = surf.Smooth(100, 0.5, surface: true, featureAngle: 60);
            ms = clock.ElapsedMilliseconds;
            Line($"| | | + surface {(r2.Ok ? "" : "(nothing to do)")} | {ms} | {Row(Measure(surf))} |");
        }
        Line("");
    }

    private static HexMesh LoadUserMesh()
    {
        var path = Path.Combine(TestContext.CurrentContext.TestDirectory, "Fixtures", "folded-by-bent-midpoints.json");
        var doc = JsonDocument.Parse(File.ReadAllText(path)).RootElement;
        var nodes = doc.GetProperty("nodes").EnumerateArray().Select(n => new NodeState(n.GetProperty("id").GetInt32(), new Vec3(n.GetProperty("x").GetDouble(), n.GetProperty("y").GetDouble(), n.GetProperty("z").GetDouble()), n.GetProperty("idealX").GetInt32(), n.GetProperty("idealY").GetInt32(), n.GetProperty("idealZ").GetInt32())).ToList();
        var hexes = doc.GetProperty("hexes").EnumerateArray().Select(h => new HexState(h.GetProperty("id").GetInt32(), h.GetProperty("cellI").GetInt32(), h.GetProperty("cellJ").GetInt32(), h.GetProperty("cellK").GetInt32(), null, h.GetProperty("nodeIds").EnumerateArray().Select(x => x.GetInt32()).ToList())).ToList();
        var links = new List<LinkState>();
        foreach (var l in doc.GetProperty("links").EnumerateArray())
        {
            links.Add(new LinkState(l.GetProperty("hexA").GetInt32(), Enum.Parse<HexFace>(l.GetProperty("faceA").GetString()!), l.GetProperty("hexB").GetInt32()));
            links.Add(new LinkState(l.GetProperty("hexB").GetInt32(), Enum.Parse<HexFace>(l.GetProperty("faceB").GetString()!), l.GetProperty("hexA").GetInt32()));
        }
        return HexMesh.FromState(new HexMeshState(nodes.Max(n => n.Id) + 1, hexes.Max(h => h.Id) + 1, nodes, hexes, links));
    }

    private static void C_the_users_mesh()
    {
        Line("## C. The mesh that could not be improved (3×3×3 cubes, 15 folded by bent edge midpoints)\n");
        Line("| run | cubes folded | max corner move | passes | " + Header.Split('\n')[0].Substring(2) + "\n|---|---|---|---|---|---|---|---|---|---|---|");
        var before = new HexMeshEditor(LoadUserMesh());
        Line($"| before | {before.Mesh.InvalidHexes().Count} | | | {Row(Measure(before))} |");
        foreach (var (name, straighten, untangle) in new[] { ("corners only (the first version)", false, false), ("+ unfold", false, true), ("+ straighten edges (final)", true, true) })
        {
            var e = new HexMeshEditor(LoadUserMesh());
            var corners = e.Mesh.Nodes.Where(n => e.Mesh.OwnersOf(n.Id).All(o => o.Slot < 8)).ToDictionary(n => n.Id, n => n.Position);
            var r = e.Mesh.Smooth(100, 0.5, false, 1, 25, untangle, straighten);
            double moved = corners.Max(c => (e.Mesh.Node(c.Key).Position - c.Value).Length);
            Line($"| {name} | {e.Mesh.InvalidHexes().Count} | {moved.ToString("0.000", C)} | {r.Passes} | {Row(Measure(e))} |");
        }
        Line("");
    }

    private static HexMeshEditor Graded(int seed, double shake)
    {
        double G(double t) => t * (0.4 + 0.1 * t);                 // cell width grows from 0.5 to 1.5 along x
        double F(double t) { int i = (int)Math.Floor(t); return i >= 6 ? G(6) : G(i) + (t - i) * (G(i + 1) - G(i)); }
        var cells = new List<BodyCell>();
        for (int i = 0; i < 6; i++)
            for (int j = 0; j < 6; j++)
                for (int k = 0; k < 6; k++)
                    cells.Add(new BodyCell(i, j, k, Enumerable.Range(0, 20).Select(s => new Vec3(F(i + (Hex20Reference.LocalCoords[s, 0] + 1) / 2.0), j + (Hex20Reference.LocalCoords[s, 1] + 1) / 2.0, k + (Hex20Reference.LocalCoords[s, 2] + 1) / 2.0)).ToList()));
        var e = new HexMeshEditor();
        e.AddBody(new BodyPlan(cells));
        var random = new Random(seed);
        foreach (var n in e.Mesh.Nodes.Where(n => n.Ideal.X % 2 == 0 && n.Ideal.Y % 2 == 0 && n.Ideal.Z % 2 == 0 && n.Ideal.X is > 0 and < 12 && n.Ideal.Y is > 0 and < 12 && n.Ideal.Z is > 0 and < 12).ToList())
            e.MoveNode(n.Id, n.Position + new Vec3(random.NextDouble() - 0.5, random.NextDouble() - 0.5, random.NextDouble() - 0.5) * shake, true);
        return e;
    }

    private static void D_density()
    {
        Line("## D. The density weight: a block graded along x (cell width 0.5 … 1.5), inner corners shaken, 1000 passes, step 0.5\n");
        Line("Worst cube quality (1 = regular) and the largest distance of an inner vertex from its place in the graded grid (the density that was there), mean of 3 seeds.\n");
        Line("| shake | density 100% | density 50% | density 0% (plain Laplacian) |\n|---|---|---|---|");
        foreach (double shake in new[] { 0.3, 0.5, 0.9, 1.3 })
        {
            var cells = new List<string>();
            foreach (double p in new[] { 1.0, 0.5, 0.0 })
            {
                double q = 0, drift = 0;
                foreach (int seed in new[] { 1, 2, 3 })
                {
                    var e = Graded(seed, shake);
                    e.Mesh.Smooth(1000, 0.5, false, p);
                    q += CubeQ(e.Mesh) / 3;
                    drift += e.Mesh.Nodes.Where(n => n.Ideal.X % 2 == 0 && n.Ideal.Y % 2 == 0 && n.Ideal.Z % 2 == 0).Max(n => Math.Abs(n.Position.X - (n.Ideal.X / 2.0) * (0.4 + 0.1 * (n.Ideal.X / 2.0)))) / 3;
                }
                cells.Add($"Q {q.ToString("0.00", C)}, drift {drift.ToString("0.00", C)}");
            }
            Line($"| {shake.ToString(C)} | {string.Join(" | ", cells)} |");
        }
        Line("");
    }

    private static void E_convergence()
    {
        Line("## E. Convergence: a shaken 6×6×6 block (shake 0.25, seed 3): worst cube quality after n passes, by step\n");
        Line("| passes | step 0.3 | step 0.5 | step 0.8 | step 1.0 |\n|---|---|---|---|---|");
        foreach (int passes in new[] { 1, 2, 3, 5, 10, 20, 50, 100, 200 })
        {
            var cells = new List<string>();
            foreach (double step in new[] { 0.3, 0.5, 0.8, 1.0 })
            {
                var e = Rough(6, 0.25, 3);
                e.Mesh.Smooth(passes, step);
                cells.Add(CubeQ(e.Mesh).ToString("0.000", C));
            }
            Line($"| {passes} | {string.Join(" | ", cells)} |");
        }
        var settle = Rough(6, 0.25, 3).Mesh.Smooth(1000, 0.5);
        Line($"\nWith step 0.5 the run stops by itself after {settle.Passes} passes (the largest move fell below 1e-9 of the body's size).\n");
    }

    private static void F_speed()
    {
        Line("## F. Speed: shaken blocks, 100 passes (or until settled), step 0.5, density 100%\n");
        Line("| cubes | passes used | time, ms |\n|---|---|---|");
        foreach (int n in new[] { 4, 6, 8, 10, 12 })
        {
            var e = Rough(n, 0.25, 1);
            var clock = Stopwatch.StartNew();
            var r = e.Mesh.Smooth(100, 0.5);
            Line($"| {n * n * n} | {r.Passes} | {clock.ElapsedMilliseconds} |");
        }
        Line("");
    }

    private static void G_stress()
    {
        Line("## G. Stress: 5×5×5 block, 12 seeds each\n");
        Line("| damage | folded before (mean) | folded after (max) | worst cube Q after (min over seeds) | corner drift (max) |\n|---|---|---|---|---|");
        foreach (var (name, bendSurface) in new[] { ("a third of the inner edge midpoints thrown by up to 0.4 of an edge", false), ("a third of ALL edge midpoints thrown the same way (the surface too)", true) })
        {
            double foldedBefore = 0, drift = 0, worstQ = 1;
            int foldedAfter = 0;
            foreach (int seed in Enumerable.Range(1, 12))
            {
                var e = new HexMeshEditor();
                e.AddBody(HexTemplates.Kind("block").Build(new Dictionary<string, double> { ["countX"] = 5, ["countY"] = 5, ["countZ"] = 5, ["length"] = 5, ["height"] = 5, ["depth"] = 5 }));
                var surface = new HashSet<int>();
                foreach (var hex in e.Mesh.Hexes) foreach (var face in HexFaces.All) if (e.Mesh.Neighbor(hex.Id, face) is null) foreach (int slot in face.Slots()) surface.Add(hex.NodeIds[slot]);
                var random = new Random(seed);
                foreach (var node in e.Mesh.Nodes.Where(n => e.Mesh.OwnersOf(n.Id).Any(o => o.Slot >= 8) && (bendSurface || !surface.Contains(n.Id))).ToList())
                    if (random.NextDouble() < 0.33) e.Mesh.SetNodePosition(node.Id, node.Position + new Vec3(random.NextDouble() - 0.5, random.NextDouble() - 0.5, random.NextDouble() - 0.5) * 0.8);
                foldedBefore += e.Mesh.InvalidHexes().Count / 12.0;
                e.Mesh.Smooth(100, 0.5);
                foldedAfter = Math.Max(foldedAfter, e.Mesh.InvalidHexes().Count);
                worstQ = Math.Min(worstQ, CubeQ(e.Mesh));
                drift = Math.Max(drift, e.Mesh.Nodes.Where(n => e.Mesh.OwnersOf(n.Id).All(o => o.Slot < 8)).Max(n => (n.Position - new Vec3(n.Ideal.X / 2.0, n.Ideal.Y / 2.0, n.Ideal.Z / 2.0)).Length));
            }
            Line($"| {name} | {foldedBefore.ToString("0.0", C)} | {foldedAfter} | {worstQ.ToString("0.00", C)} | {drift.ToString("0.000", C)} |");
        }
        Line("");
        Line("Corners thrown (the 8 inner... all inner corners of a 6×6×6 shaken block moved by up to 0.45 of a cube):\n");
        Line("| seed | folded before | folded after | worst cube Q after |\n|---|---|---|---|");
        foreach (int seed in Enumerable.Range(1, 6))
        {
            var e = Rough(6, 0.25, seed);
            var random = new Random(seed);
            foreach (var node in e.Mesh.Nodes.Where(n => n.Ideal.X % 2 == 0 && n.Ideal.Y % 2 == 0 && n.Ideal.Z % 2 == 0 && n.Ideal.X is > 0 and < 12 && n.Ideal.Y is > 0 and < 12 && n.Ideal.Z is > 0 and < 12).ToList())
                e.MoveNode(node.Id, node.Position + new Vec3(random.NextDouble() - 0.5, random.NextDouble() - 0.5, random.NextDouble() - 0.5) * 0.9, true);
            int before = e.Mesh.InvalidHexes().Count;
            e.Mesh.Smooth(200, 0.5);
            Line($"| {seed} | {before} | {e.Mesh.InvalidHexes().Count} | {CubeQ(e.Mesh).ToString("0.00", C)} |");
        }
        Line("");
    }
}
