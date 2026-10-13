using NUnit.Framework;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>Research: how good is the smoothing. Prints tables; the assertions are in SmoothingQualityTests.</summary>
public class SmoothingStudy
{
    internal record Snap(int Folded, int Bad, int Elements, double MinSJ, double MinAngle, double MaxAngle, double Skew, double JacRatio, double Warp, double MinDet);

    internal static Snap Measure(HexMeshEditor editor, int div = 1)
    {
        var facade = NewFacade();
        if (div > 1) facade.SetDivisions(1, div, div, div);
        var q = facade.Quality(1, Export(editor)).Profiles.Single(p => p.Id == "solvix");
        double G(string k) => q.Worst[k];
        return new Snap(editor.Mesh.InvalidHexes().Count, q.Grades.GetValueOrDefault("poor") + q.Grades.GetValueOrDefault("invalid"), q.Elements,
            G("scaledJacobian"), G("minCornerAngle"), G("maxCornerAngle"), G("equiangleSkew"), G("jacobianRatio"), G("warpingFactor"), editor.Mesh.Hexes.Min(h => h.MinDeterminant()));
    }

    static void Log(string line) { Console.WriteLine(line); File.AppendAllText("/tmp/study_progress.log", line + "\n"); }

    static string Fmt(Snap s) => $"fold {s.Folded,3} bad {s.Bad,4}/{s.Elements,-4} SJ {s.MinSJ,5:0.00} minA {s.MinAngle,5:0.0} maxA {s.MaxAngle,6:0.0} skew {s.Skew,4:0.00} JR {Math.Min(s.JacRatio, 9999),7:0.0} warp {s.Warp,5:0.00} minDet {s.MinDet,7:0.0000}";

    static HexMeshEditor Rough(int n, double jitter, int seed)
    {
        var e = new HexMeshEditor();
        e.AddBody(HexTemplates.Kind("rough-block").Build(new Dictionary<string, double> { ["countX"] = n, ["countY"] = n, ["countZ"] = n, ["length"] = n, ["height"] = n, ["depth"] = n, ["jitter"] = jitter, ["seed"] = seed }));
        return e;
    }

    [Test]
    public void A_rough_blocks()
    {
        foreach (var n in new[] { 5, 8 })
            foreach (var jitter in new[] { 0.1, 0.2, 0.25 })
            {
                var e = Rough(n, jitter, 3);
                Console.WriteLine($"STUDY A n={n} jitter={jitter} before: {Fmt(Measure(e))}");
                foreach (var its in new[] { 5, 20, 100 })
                {
                    var e2 = Rough(n, jitter, 3);
                    e2.Smooth(its, 0.5);
                    Console.WriteLine($"STUDY A n={n} jitter={jitter} its={its,3}: {Fmt(Measure(e2))}");
                }
            }
    }

    [Test]
    public void B_presets()
    {
        foreach (var p in HexTemplates.Presets)
        {
            var e = new HexMeshEditor();
            e.AddBody(HexTemplates.Kind(p.Kind).Build(p.Values));
            var before = Measure(e);
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var r = e.Smooth(30, 0.5);
            var took = clock.ElapsedMilliseconds;
            var after = Measure(e);
            var e3 = new HexMeshEditor();
            e3.AddBody(HexTemplates.Kind(p.Kind).Build(p.Values));
            var r3 = e3.Smooth(30, 0.5, surface: true, featureAngle: 60);
            var surf = Measure(e3);
            Log($"STUDY B {p.Name,-34} cubes {e.Mesh.Hexes.Count,4} before: {Fmt(before)}");
            Log($"STUDY B {"",-34} inner ok={r.Ok} {took} ms after: {Fmt(after)}");
            Log($"STUDY B {"",-34} +surf ok={r3.Ok} after: {Fmt(surf)}");
        }
    }
}
