using Refinement2D.Core;

namespace Refinement2D.Tests;

public class RefinerTests
{
    private static void AssertConforming(QuadMesh mesh, string what = "")
    {
        var problems = Conformity.Check(mesh);
        Assert.That(problems, Is.Empty, what + "\n" + string.Join("\n", problems.Take(8)));
    }

    private static IEnumerable<int> LeavesOf(QuadMesh mesh, params (int I, int J)[] roots) =>
        mesh.Roots.Where(r => roots.Contains((r.I, r.J))).SelectMany(r => r.Leaves);

    [Test]
    public void A_plain_grid_is_conforming()
    {
        var mesh = QuadMesh.Grid(4, 3);

        AssertConforming(mesh);
        Assert.That(mesh.Cells, Has.Count.EqualTo(12));
    }

    [Test]
    public void One_cell_in_the_middle_is_split_n_by_n_and_the_rest_of_the_mesh_is_conforming()
    {
        var mesh = QuadMesh.Grid(7, 7);

        Refiner.Refine(mesh, LeavesOf(mesh, (3, 3)), 2, 2);

        AssertConforming(mesh);
        // the marked cell is cut into 2 x 2 equal squares
        var root = mesh.Roots.Single(r => r.I == 3 && r.J == 3);
        Assert.That(root.Leaves, Has.Count.EqualTo(4));
        Assert.That(root.Leaves.Select(id => Area(mesh, id)).Distinct().Count(), Is.EqualTo(1));
    }

    [Test]
    public void Every_marked_cell_ends_up_cut_into_nI_by_nJ_equal_rectangles_for_any_n()
    {
        foreach (var (nI, nJ) in new[] { (2, 2), (3, 2), (2, 4), (3, 3), (5, 2) })
        {
            var mesh = QuadMesh.Grid(9, 9);

            Refiner.Refine(mesh, LeavesOf(mesh, (4, 4), (5, 6)), nI, nJ);

            AssertConforming(mesh, $"n = {nI} x {nJ}");
            foreach (var (i, j) in new[] { (4, 4), (5, 6) })
            {
                var root = mesh.Roots.Single(r => r.I == i && r.J == j);
                Assert.That(root.Leaves, Has.Count.EqualTo(nI * nJ), $"({i},{j}) n = {nI} x {nJ}");
                Assert.That(root.Leaves.Select(id => Area(mesh, id)).Distinct().Count(), Is.EqualTo(1));
            }
        }
    }

    [Test]
    public void Random_sets_of_marked_cells_on_grids_with_holes_always_give_a_conforming_mesh()
    {
        var random = new Random(2024);
        for (int trial = 0; trial < 1500; trial++)
        {
            int nx = random.Next(3, 10), ny = random.Next(3, 10);
            var holes = Enumerable.Range(0, nx * ny).Where(_ => random.NextDouble() < 0.15).Select(k => (k % nx, k / nx)).ToList();
            QuadMesh mesh;
            try { mesh = QuadMesh.Grid(nx, ny, holes); } catch (ArgumentException) { continue; }
            var pick = mesh.Roots.Where(_ => random.NextDouble() < 0.2).SelectMany(r => r.Leaves).ToList();
            if (pick.Count == 0) continue;
            int nI = random.Next(2, 7), nJ = random.Next(2, 7);

            Refiner.Refine(mesh, pick, nI, nJ);

            AssertConforming(mesh, $"trial {trial}: {nx}x{ny}, {holes.Count} holes, {pick.Count} marked, n = {nI}x{nJ}");
        }
    }

    [Test]
    public void Marking_every_cell_splits_all_of_them_and_a_single_cell_grid_works()
    {
        var all = QuadMesh.Grid(4, 4);
        Refiner.Refine(all, all.Cells.Keys.ToList(), 3, 2);
        AssertConforming(all);
        Assert.That(all.Cells, Has.Count.EqualTo(16 * 6));

        var one = QuadMesh.Grid(1, 1);
        Refiner.Refine(one, one.Cells.Keys.ToList(), 2, 2);
        AssertConforming(one);
        Assert.That(one.Cells, Has.Count.EqualTo(4));
    }

    [Test]
    public void Neighbours_of_the_marked_cell_get_templates_not_a_full_split()
    {
        var mesh = QuadMesh.Grid(5, 5);

        Refiner.Refine(mesh, LeavesOf(mesh, (2, 2)), 2, 2);

        // the whole mesh has more cells than the 4 of the split cell plus the other 24, so transitions exist; but far cells are untouched
        Assert.That(mesh.Roots.Single(r => r.I == 0 && r.J == 0).Leaves, Has.Count.EqualTo(1));
        Assert.That(mesh.Roots.Single(r => r.I == 4 && r.J == 4).Leaves, Has.Count.EqualTo(1));
        Assert.That(mesh.Cells.Count, Is.GreaterThan(24 + 4));
    }

    [Test]
    public void The_result_does_not_depend_on_the_order_in_which_the_marked_cells_are_given()
    {
        var a = QuadMesh.Grid(8, 8);
        var b = QuadMesh.Grid(8, 8);
        var cells = new[] { (1, 1), (2, 3), (5, 5), (6, 2) };

        Refiner.Refine(a, LeavesOf(a, cells), 3, 2);
        Refiner.Refine(b, LeavesOf(b, cells).Reverse(), 3, 2);

        Assert.That(Signature(a), Is.EqualTo(Signature(b)));
    }

    [Test]
    public void A_cell_at_the_edge_of_an_odd_chain_pairs_with_nothing_and_still_conforms()
    {
        var mesh = QuadMesh.Grid(5, 1);

        Refiner.Refine(mesh, LeavesOf(mesh, (4, 0)), 2, 2);                 // the last of five: it has no partner

        AssertConforming(mesh);
        Assert.That(mesh.Roots.Single(r => r.I == 4).Leaves, Has.Count.EqualTo(4));
    }

    [Test]
    public void Layers_are_paired_by_their_place_in_the_whole_grid_so_the_seams_line_up_across_holes()
    {
        // holes put the cells of different rows at different distances from the start of their rows; the pairing must not care
        var mesh = QuadMesh.Grid(7, 6, new[] { (0, 0), (1, 1), (0, 3), (2, 4), (1, 2) });

        Refiner.Refine(mesh, LeavesOf(mesh, (3, 3), (4, 2)), 2, 3);

        AssertConforming(mesh);
    }

    // ---- helpers -------------------------------------------------------------------------------------------------------

    private static long Area(QuadMesh mesh, int id)
    {
        var p = mesh.Cells[id].Nodes.Select(mesh.PointOf).ToArray();
        long a = 0;
        for (int k = 0; k < 4; k++) a += p[k].X * p[(k + 1) % 4].Y - p[(k + 1) % 4].X * p[k].Y;
        return a;
    }

    private static string Signature(QuadMesh mesh) =>
        string.Join(";", mesh.Cells.Values
            .Select(c => string.Join(",", c.Nodes.Select(mesh.PointOf).Select(p => $"{p.X}:{p.Y}")))
            .OrderBy(s => s, StringComparer.Ordinal));
}
