using Refinement3D.Core;

namespace Refinement3D.Tests;

/// <summary>How often a marked leaf of an earlier refinement ends up cut into exactly nI x nJ x nK pieces. A leaf that is not is reported as unreached, never silently.</summary>
public class LeafCoverageTests
{
    private static bool IsBox(HexMesh mesh, Cell c)
    {
        var p = mesh.CornersOf(c);
        for (int s = 0; s < 8; s++)
            for (int axis = 0; axis < 3; axis++)
            {
                var q = p[s ^ (1 << axis)];
                for (int other = 0; other < 3; other++) if (other != axis && q[other] != p[s][other]) return false;
            }
        return true;
    }

    private static (long X0, long Y0, long Z0, long X1, long Y1, long Z1) BoxOf(HexMesh mesh, Cell c)
    {
        var p = mesh.CornersOf(c);
        return (p.Min(q => q.X), p.Min(q => q.Y), p.Min(q => q.Z), p.Max(q => q.X), p.Max(q => q.Y), p.Max(q => q.Z));
    }

    [Test]
    public void The_box_leaves_that_are_marked_end_up_cut_into_nI_nJ_nK_pieces_or_are_reported()
    {
        var random = new Random(5);
        int checkedLeaves = 0, whole = 0, silent = 0;
        for (int trial = 0; trial < 120; trial++)
        {
            var mesh = HexMesh.Grid(3, 3, 3);
            Refiner.Refine(mesh, mesh.Roots.Where(_ => random.NextDouble() < 0.3).SelectMany(r => r.Leaves).ToList(), 2, 2, 2);
            var boxes = mesh.Cells.Values.Where(c => IsBox(mesh, c)).Select(c => c.Id).Where(_ => random.NextDouble() < 0.06).ToList();
            if (boxes.Count == 0) continue;
            long before = mesh.Scale;
            var regions = boxes.ToDictionary(id => id, id => BoxOf(mesh, mesh.Cells[id]));
            int nI = random.Next(2, 4), nJ = random.Next(2, 4), nK = random.Next(2, 4);

            var result = Refiner.Refine(mesh, boxes, nI, nJ, nK);

            Assert.That(Conformity.Check(mesh), Is.Empty, $"trial {trial}");
            long f = mesh.Scale / before;
            bool reported = result.Passes.Any(p => p.Unreached.Count > 0);
            foreach (var (_, b) in regions)
            {
                checkedLeaves++;
                var (x0, y0, z0, x1, y1, z1) = (b.X0 * f, b.Y0 * f, b.Z0 * f, b.X1 * f, b.Y1 * f, b.Z1 * f);
                var pieces = mesh.Cells.Values.Where(c => IsBox(mesh, c)).Select(c => BoxOf(mesh, c))
                    .Where(q => q.X0 >= x0 && q.X1 <= x1 && q.Y0 >= y0 && q.Y1 <= y1 && q.Z0 >= z0 && q.Z1 <= z1).ToList();
                long volume = pieces.Sum(q => (q.X1 - q.X0) * (q.Y1 - q.Y0) * (q.Z1 - q.Z0));
                if (pieces.Count == nI * nJ * nK && volume == (x1 - x0) * (y1 - y0) * (z1 - z0)) whole++;
                else if (!reported) silent++;
            }
        }
        TestContext.Out.WriteLine($"LEAVES3D whole {whole} of {checkedLeaves}; not cut and not reported: {silent}");
        Assert.That(silent, Is.Zero, "a leaf was not cut in full and nothing said so");
        Assert.That(whole, Is.GreaterThan(checkedLeaves * 0.95), "most marked leaves must be cut as asked");
    }
}
