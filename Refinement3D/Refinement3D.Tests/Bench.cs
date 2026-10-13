using System.Diagnostics;
using Refinement3D.Core;

namespace Refinement3D.Tests;

public class Bench
{
    [Test, Explicit("the study: run it to see the numbers")]
    public void Blocks()
    {
        foreach (var (side, block, n, depth) in new[] { (12, 4, 2, 0), (12, 6, 2, 0), (12, 6, 3, 0), (16, 8, 2, 0), (12, 4, 2, 2), (16, 6, 3, 1) })
        {
            var mesh = HexMesh.Grid(side, side, side);
            int lo = (side - block) / 2;
            var chosen = mesh.Roots.Where(r => r.I >= lo && r.I < lo + block && r.J >= lo && r.J < lo + block && r.K >= lo && r.K < lo + block).SelectMany(r => r.Leaves).ToList();
            var sw = Stopwatch.StartNew();
            var result = Refiner.Refine(mesh, chosen, n, n, n, depth);
            long t = sw.ElapsedMilliseconds; sw.Restart();
            var problems = Conformity.Check(mesh);
            TestContext.Out.WriteLine($"BLOCK grid {side}^3, block {block}^3 ({chosen.Count} cells), n {n}, depth {depth}: {mesh.Cells.Count} cells, refine {t} ms, conformity {sw.ElapsedMilliseconds} ms ({problems.Count} problems), unreached {result.Passes.Sum(p => p.Unreached.Count)}");
        }
    }

    [Test, Explicit("the study: run it to see the numbers")]
    public void Scale()
    {
        foreach (int side in new[] { 6, 8, 10, 12, 16 })
        {
            var random = new System.Random(1);
            var mesh = HexMesh.Grid(side, side, side);
            var chosen = mesh.Roots.Where(_ => random.NextDouble() < 0.04).SelectMany(r => r.Leaves).ToList();
            var sw = Stopwatch.StartNew();
            var result = Refiner.Refine(mesh, chosen, 2, 2, 2, 0);
            long tRefine = sw.ElapsedMilliseconds; sw.Restart();
            var problems = Conformity.Check(mesh);
            long tCheck = sw.ElapsedMilliseconds; sw.Restart();
            var lap = Smoothing.Smooth(mesh, new SmoothingOptions(10, 0.5, 0.5, true));
            long tLap = sw.ElapsedMilliseconds; sw.Restart();
            var opt = Smoothing.Smooth(mesh, new SmoothingOptions(0, 0.5, 0.5, true, 5));
            long tOpt = sw.ElapsedMilliseconds;
            TestContext.Out.WriteLine($"SCALE side {side}: roots {side * side * side}, chosen {chosen.Count} cells, result {mesh.Cells.Count} cells, refine {tRefine} ms, conformity {tCheck} ms ({problems.Count} problems), Laplacian 10 passes {tLap} ms, optimization 5 passes {tOpt} ms; worst {opt.Before.MinScaled:0.000}->{opt.After.MinScaled:0.000}");
        }
    }
}
