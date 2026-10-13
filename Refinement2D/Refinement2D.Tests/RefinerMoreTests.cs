using Refinement2D.Core;

namespace Refinement2D.Tests;

/// <summary>What the first tests leave out: the parts of the algorithm one by one (marks, completion, templates, the seams of a cell's own), the invariants of the result, order and repetition, large n, bad input, the detailed preview.</summary>
public class RefinerMoreTests
{
    private static void AssertConforming(QuadMesh mesh, string what = "")
    {
        var problems = Conformity.Check(mesh);
        Assert.That(problems, Is.Empty, what + "\n" + string.Join("\n", problems.Take(8)));
    }

    private static string Signature(QuadMesh mesh) =>
        string.Join(";", mesh.Cells.Values
            .Select(c => string.Join(",", c.Nodes.Select(mesh.PointOf).Select(p => $"{p.X}:{p.Y}")))
            .OrderBy(s => s, StringComparer.Ordinal));

    // the doubled area of all the cells, in the unit of the coarse lattice (so meshes at different scales can be compared)
    private static double TotalArea(QuadMesh mesh)
    {
        double sum = 0;
        foreach (var cell in mesh.Cells.Values)
        {
            var p = cell.Nodes.Select(mesh.PointOf).ToArray();
            long a = 0;
            for (int k = 0; k < 4; k++) a += p[k].X * p[(k + 1) % 4].Y - p[(k + 1) % 4].X * p[k].Y;
            sum += a;
        }
        return sum / ((double)mesh.Scale * mesh.Scale);
    }

    // a mesh refined once on a random part of a random grid, for the tests of a second refinement
    private static QuadMesh RefinedOnce(Random random, out int nx, out int ny)
    {
        nx = random.Next(3, 8);
        ny = random.Next(3, 8);
        var mesh = QuadMesh.Grid(nx, ny);
        var first = mesh.Roots.Where(_ => random.NextDouble() < 0.25).SelectMany(r => r.Leaves).ToList();
        if (first.Count == 0) first = mesh.Roots[0].Leaves.ToList();
        Refiner.Refine(mesh, first, random.Next(2, 4), random.Next(2, 4));
        return mesh;
    }

    // ---- the invariants of the result ---------------------------------------------------------------------------------------

    [Test]
    public void The_total_area_never_changes_the_cells_only_split_it()
    {
        var random = new Random(11);
        for (int trial = 0; trial < 300; trial++)
        {
            var mesh = RefinedOnce(random, out _, out _);
            double before = TotalArea(mesh);
            var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.08).ToList();
            if (leaves.Count == 0) continue;

            Refiner.Refine(mesh, leaves, random.Next(2, 5), random.Next(2, 5));

            Assert.That(TotalArea(mesh), Is.EqualTo(before).Within(1e-9), $"trial {trial}");
        }
    }

    [Test]
    public void Nodes_are_unique_points_and_every_node_belongs_to_a_cell()
    {
        var random = new Random(12);
        for (int trial = 0; trial < 200; trial++)
        {
            var mesh = RefinedOnce(random, out _, out _);
            var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.08).ToList();
            if (leaves.Count > 0) Refiner.Refine(mesh, leaves, random.Next(2, 4), random.Next(2, 4));

            Assert.That(mesh.Nodes.Distinct().Count(), Is.EqualTo(mesh.Nodes.Count), $"trial {trial}: two nodes at one point");
            var used = mesh.Cells.Values.SelectMany(c => c.Nodes).ToHashSet();
            Assert.That(used.Count, Is.EqualTo(mesh.Nodes.Count), $"trial {trial}: a node that no cell uses");
        }
    }

    [Test]
    public void A_refinement_of_a_clone_leaves_the_original_alone()
    {
        var mesh = QuadMesh.Grid(6, 6);
        Refiner.Refine(mesh, mesh.Roots[7].Leaves.ToList(), 2, 2);
        string before = Signature(mesh);
        long scale = mesh.Scale;
        var clone = mesh.Clone();

        Refiner.Refine(clone, clone.Cells.Keys.Take(3).ToList(), 3, 2);

        Assert.That(Signature(mesh), Is.EqualTo(before));
        Assert.That(mesh.Scale, Is.EqualTo(scale));
    }

    // ---- the parts: completion, marks, templates ----------------------------------------------------------------------------

    [Test]
    public void Three_marks_in_a_cell_are_completed_to_four_and_a_diagonal_pair_too()
    {
        var mesh = QuadMesh.Grid(3, 3);
        var cell = mesh.Cells[4];                                         // the middle cell: its neighbours are not touched by the marks below

        var three = new HashSet<int> { cell.Nodes[0], cell.Nodes[1], cell.Nodes[2] };
        Refiner.Complete(mesh, three);
        Assert.That(cell.Nodes.All(three.Contains), "three marks must become four");

        var diagonal = new HashSet<int> { cell.Nodes[0], cell.Nodes[2] };
        Refiner.Complete(mesh, diagonal);
        Assert.That(cell.Nodes.All(diagonal.Contains), "a diagonal pair must become four");
    }

    [Test]
    public void None_one_corner_and_one_edge_are_left_as_they_are_by_the_completion()
    {
        var mesh = QuadMesh.Grid(3, 3);
        var cell = mesh.Cells[4];
        foreach (var marks in new[] { new HashSet<int>(), new HashSet<int> { cell.Nodes[0] }, new HashSet<int> { cell.Nodes[0], cell.Nodes[1] }, new HashSet<int> { cell.Nodes[3], cell.Nodes[0] } })
        {
            int count = marks.Count;
            Refiner.Complete(mesh, marks);
            Assert.That(marks, Has.Count.EqualTo(count));
        }
    }

    [Test]
    public void The_completion_can_run_on_through_neighbours()
    {
        // two diagonal marks of one cell: completing it gives the neighbour cells a pattern of two (an edge, fine) - but marking the diagonal of a 2x2 block
        // makes every cell of the block a corner or an edge, so the chain stops; this only checks that the result is always an allowed pattern
        var random = new Random(3);
        for (int trial = 0; trial < 300; trial++)
        {
            var mesh = QuadMesh.Grid(5, 5);
            var marks = Enumerable.Range(0, mesh.Nodes.Count).Where(_ => random.NextDouble() < 0.3).ToHashSet();
            Refiner.Complete(mesh, marks);
            foreach (var cell in mesh.Cells.Values)
            {
                var slots = Enumerable.Range(0, 4).Where(s => marks.Contains(cell.Nodes[s])).ToList();
                bool allowed = slots.Count is 0 or 1 or 4 || (slots.Count == 2 && slots[1] - slots[0] != 2);
                Assert.That(allowed, $"trial {trial}: cell {cell.Id} has marks at {string.Join(",", slots)}");
            }
        }
    }

    [Test]
    public void The_seam_of_a_leaf_marks_only_its_own_edge_on_the_seam()
    {
        var random = new Random(21);
        for (int trial = 0; trial < 150; trial++)
        {
            var mesh = RefinedOnce(random, out _, out _);
            var leaf = mesh.Cells.Keys.ElementAt(random.Next(mesh.Cells.Count));
            int axis = random.Next(2), n = random.Next(2, 4);
            mesh.Rescale(n);

            var marks = Refiner.MarkNodes(mesh, new HashSet<int> { leaf }, axis);

            var points = marks.Select(mesh.PointOf).ToList();
            var own = mesh.Cells[leaf].Nodes.Select(mesh.PointOf).ToList();
            long Along(Pt p) => axis == 0 ? p.X : p.Y;
            long Across(Pt p) => axis == 0 ? p.Y : p.X;
            if (points.Count == 0) continue;                              // the leaf does not touch the seam of its layers: it gets one of its own later
            Assert.That(points.Select(Along).Distinct().Count(), Is.EqualTo(1), $"trial {trial}: the marks are on one seam line");
            Assert.That(points.All(p => Across(p) >= own.Min(Across) && Across(p) <= own.Max(Across)), $"trial {trial}: a mark outside the leaf's own edge");
        }
    }

    [Test]
    public void The_templates_give_n_pieces_on_an_edge_and_two_n_minus_one_round_a_corner()
    {
        for (int n = 2; n <= 7; n++)
        {
            var mesh = QuadMesh.Grid(7, 7);
            var result = Refiner.Refine(mesh, mesh.Roots[24].Leaves.ToList(), n, n);

            var applied = result.Passes[0].Applied;
            Assert.That(applied.Where(a => a.Template == "T2").All(a => a.Children.Count == n), $"n = {n}: T2 must give n strips");
            Assert.That(applied.Where(a => a.Template == "T1").All(a => a.Children.Count == 2 * n - 1), $"n = {n}: T1 must give 2n - 1 pieces");
            Assert.That(applied, Is.Not.Empty);
        }
    }

    // ---- what the first level always does ------------------------------------------------------------------------------------

    [Test]
    public void At_the_first_level_no_marked_cell_is_ever_left_unreached()
    {
        var random = new Random(31);
        for (int trial = 0; trial < 400; trial++)
        {
            int nx = random.Next(2, 9), ny = random.Next(2, 9);
            var holes = Enumerable.Range(0, nx).SelectMany(i => Enumerable.Range(0, ny).Select(j => (i, j))).Where(_ => random.NextDouble() < 0.15).ToList();
            var mesh = QuadMesh.Grid(nx, ny, holes);
            if (mesh.Roots.Count == 0) continue;
            var marked = mesh.Roots.Where(_ => random.NextDouble() < 0.3).SelectMany(r => r.Leaves).ToList();
            if (marked.Count == 0) continue;

            var result = Refiner.Refine(mesh, marked, random.Next(2, 6), random.Next(2, 6));

            Assert.That(result.Passes.SelectMany(p => p.Unreached), Is.Empty, $"trial {trial}");
        }
    }

    [Test]
    public void Large_n_still_gives_a_conforming_mesh_at_both_levels()
    {
        var random = new Random(41);
        for (int trial = 0; trial < 60; trial++)
        {
            var mesh = QuadMesh.Grid(random.Next(3, 6), random.Next(3, 6));
            var first = mesh.Roots.Where(_ => random.NextDouble() < 0.3).SelectMany(r => r.Leaves).ToList();
            if (first.Count == 0) continue;
            int nI = random.Next(6, 11), nJ = random.Next(6, 11);
            Refiner.Refine(mesh, first, nI, nJ);
            AssertConforming(mesh, $"trial {trial}: first level, n = {nI}x{nJ}");

            var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.01).ToList();
            if (leaves.Count == 0) continue;
            Refiner.Refine(mesh, leaves, random.Next(6, 9), random.Next(6, 9));
            AssertConforming(mesh, $"trial {trial}: second level");
        }
    }

    // ---- order, repetition, odd shapes of the grid ---------------------------------------------------------------------------

    [Test]
    public void The_result_of_a_second_refinement_does_not_depend_on_the_order_of_the_marked_leaves()
    {
        var random = new Random(51);
        for (int trial = 0; trial < 200; trial++)
        {
            var a = RefinedOnce(random, out _, out _);
            var b = a.Clone();
            var leaves = a.Cells.Keys.Where(_ => random.NextDouble() < 0.08).ToList();
            if (leaves.Count < 2) continue;
            int nI = random.Next(2, 4), nJ = random.Next(2, 4);

            Refiner.Refine(a, leaves, nI, nJ);
            Refiner.Refine(b, Enumerable.Reverse(leaves).ToList(), nI, nJ);

            Assert.That(Signature(a), Is.EqualTo(Signature(b)), $"trial {trial}");
        }
    }

    [Test]
    public void The_same_refinement_twice_gives_the_same_mesh()
    {
        var random = new Random(52);
        for (int trial = 0; trial < 100; trial++)
        {
            var a = RefinedOnce(random, out _, out _);
            var b = a.Clone();
            var leaves = a.Cells.Keys.Where(_ => random.NextDouble() < 0.08).ToList();
            if (leaves.Count == 0) continue;

            Refiner.Refine(a, leaves, 2, 3);
            Refiner.Refine(b, leaves, 2, 3);

            Assert.That(Signature(a), Is.EqualTo(Signature(b)), $"trial {trial}");
        }
    }

    [Test]
    public void Narrow_grids_and_the_corners_of_the_grid_work()
    {
        foreach (var (nx, ny) in new[] { (1, 1), (1, 5), (5, 1), (2, 2) })
            foreach (int n in new[] { 2, 3, 8 })
            {
                var mesh = QuadMesh.Grid(nx, ny);
                Refiner.Refine(mesh, mesh.Roots[0].Leaves.ToList(), n, n);                 // the corner root
                AssertConforming(mesh, $"{nx}x{ny}, n = {n}, the first root");
                var last = QuadMesh.Grid(nx, ny);
                Refiner.Refine(last, last.Roots[^1].Leaves.ToList(), n, n);                // the opposite corner
                AssertConforming(last, $"{nx}x{ny}, n = {n}, the last root");
            }
    }

    [Test]
    public void A_cell_next_to_a_hole_and_a_cell_cut_off_by_holes_work()
    {
        var holes = new[] { (1, 0), (0, 1), (2, 1), (1, 2) };                   // the cell (1, 1) is surrounded by holes on all four sides
        var mesh = QuadMesh.Grid(3, 3, holes);
        var middle = mesh.Roots.Single(r => r.I == 1 && r.J == 1).Leaves.ToList();

        Refiner.Refine(mesh, middle, 3, 3);

        AssertConforming(mesh);
        Assert.That(mesh.Roots.Single(r => r.I == 1 && r.J == 1).Leaves, Has.Count.EqualTo(9));
    }

    // ---- bad input -----------------------------------------------------------------------------------------------------------

    [Test]
    public void An_n_below_two_or_an_unknown_cell_is_refused_and_the_mesh_is_untouched()
    {
        var mesh = QuadMesh.Grid(3, 3);
        string before = Signature(mesh);

        Assert.Throws<ArgumentOutOfRangeException>(() => Refiner.Refine(mesh, new[] { 0 }, 1, 2));
        Assert.Throws<ArgumentOutOfRangeException>(() => Refiner.Refine(mesh, new[] { 0 }, 2, 1));
        Assert.Throws<ArgumentException>(() => Refiner.Refine(mesh, new[] { 999 }, 2, 2));
        Assert.That(Signature(mesh), Is.EqualTo(before));
    }

    // ---- the detailed preview and the seams of a cell's own -----------------------------------------------------------------

    [Test]
    public void The_detailed_preview_ends_in_the_same_mesh_as_refining_and_the_plain_preview()
    {
        var random = new Random(61);
        for (int trial = 0; trial < 100; trial++)
        {
            var a = RefinedOnce(random, out _, out _);
            var leaves = a.Cells.Keys.Where(_ => random.NextDouble() < 0.08).ToList();
            if (leaves.Count == 0) continue;
            var plain = Refiner.Preview(a, leaves, 2, 2);
            var detailed = Refiner.Preview(a, leaves, 2, 2, detailed: true);
            var refined = a.Clone();
            Refiner.Refine(refined, leaves, 2, 2);

            Assert.That(Signature(detailed[^1].Mesh!), Is.EqualTo(Signature(refined)), $"trial {trial}");
            Assert.That(Signature(plain[^1].Mesh!), Is.EqualTo(Signature(refined)), $"trial {trial}");
            Assert.That(detailed.Where(s => s.Kind is not ("layers" or "seam")).Select(s => s.Kind), Is.EqualTo(plain.Select(s => s.Kind)), "the detailed preview only adds stages");
        }
    }

    [Test]
    public void Every_attempt_at_a_seam_of_its_own_says_truthfully_whether_it_was_kept()
    {
        var random = new Random(71);
        int tries = 0, kept = 0, refused = 0;
        for (int trial = 0; trial < 200; trial++)
        {
            var a = RefinedOnce(random, out _, out _);
            var leaves = a.Cells.Keys.Where(_ => random.NextDouble() < 0.1).ToList();
            if (leaves.Count == 0) continue;

            var steps = Refiner.Preview(a, leaves, 2, 2, detailed: true);

            for (int k = 0; k < steps.Count; k++)
            {
                if (steps[k].Kind == "layers") Assert.That(steps[k].Mesh, Is.Not.Null, "a layers stage carries its mesh");
                if (steps[k].Kind != "seam") continue;
                var t = steps[k].Try!;
                tries++;
                Assert.That(steps[k].Mesh, Is.Null, "a seam stage uses the mesh of the layers stage before it");
                Assert.That(steps.Take(k).Any(s => s.Kind == "layers"));
                Assert.That(t.EdgeNodes, Has.Count.EqualTo(2));
                Assert.That(t.Added.Intersect(t.EdgeNodes), Is.Empty, "the nodes added by the completion are not the nodes of the edge");
                if (t.Accepted) { kept++; Assert.That(t.CutAcross && t.Spoiled.Count == 0, $"trial {trial}: an accepted attempt must cut the cell and spoil nothing"); }
                else { refused++; Assert.That(!t.CutAcross || t.Spoiled.Count > 0, $"trial {trial}: a refused attempt must have a reason"); }
            }
            // after the last attempt of a cell that was kept, the cell is not among the unreached of the marks stage of the same pass
            for (int k = 0; k < steps.Count; k++)
            {
                if (steps[k].Kind != "marks") continue;
                var keptCells = steps.Take(k).Reverse().TakeWhile(s => s.Kind != "templates" && s.Kind != "expand").Where(s => s.Kind == "seam" && s.Try!.Accepted).Select(s => s.Try!.Cell);
                Assert.That(keptCells.Intersect(steps[k].Unreached), Is.Empty, $"trial {trial}: a cell with a kept seam is reported unreached");
            }
        }
        TestContext.Out.WriteLine($"SEAMTRIES {tries}: kept {kept}, refused {refused}");
        Assert.That(tries, Is.GreaterThan(0), "the random cases never needed a seam of a cell's own, so this test checks nothing");
    }
}
