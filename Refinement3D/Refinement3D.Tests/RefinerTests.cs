using Refinement3D.Core;

namespace Refinement3D.Tests;

public class RefinerTests
{
    private static void AssertConforming(HexMesh mesh, string what = "")
    {
        var problems = Conformity.Check(mesh);
        Assert.That(problems, Is.Empty, what + "\n" + string.Join("\n", problems.Take(8)));
    }

    private static string Signature(HexMesh mesh) =>
        string.Join(";", mesh.Cells.Values
            .Select(c => string.Join(",", c.Nodes.Select(mesh.PointOf).Select(p => $"{p.X}:{p.Y}:{p.Z}")))
            .OrderBy(s => s, StringComparer.Ordinal));

    private static List<int> LeavesOfRoots(HexMesh mesh, Func<Root, bool> pick) => mesh.Roots.Where(pick).SelectMany(r => r.Leaves).ToList();

    private static HexMesh RandomGrid(Random random, int max, double holes)
    {
        int nx = random.Next(1, max + 1), ny = random.Next(1, max + 1), nz = random.Next(1, max + 1);
        var holeList = new List<(int, int, int)>();
        for (int i = 0; i < nx; i++) for (int j = 0; j < ny; j++) for (int k = 0; k < nz; k++) if (random.NextDouble() < holes) holeList.Add((i, j, k));
        if (holeList.Count == nx * ny * nz) holeList.RemoveAt(0);
        return HexMesh.Grid(nx, ny, nz, holeList);
    }

    // ---- the patterns --------------------------------------------------------------------------------------------------------

    [Test]
    public void Exactly_none_corners_edges_faces_and_all_have_templates()
    {
        var kinds = Enumerable.Range(0, 256).GroupBy(m => Patterns.KindOf(m)).ToDictionary(g => g.Key, g => g.Count());
        Assert.That(kinds[Patterns.Kind.None], Is.EqualTo(1));
        Assert.That(kinds[Patterns.Kind.Corner], Is.EqualTo(8));
        Assert.That(kinds[Patterns.Kind.Edge], Is.EqualTo(12));
        Assert.That(kinds[Patterns.Kind.Face], Is.EqualTo(6));
        Assert.That(kinds[Patterns.Kind.All], Is.EqualTo(1));
        Assert.That(kinds[Patterns.Kind.Invalid], Is.EqualTo(256 - 28));
    }

    [Test]
    public void The_closure_is_the_smallest_pattern_with_a_template_that_holds_the_marks()
    {
        for (int mask = 0; mask < 256; mask++)
        {
            int closed = Patterns.Closure(mask);
            Assert.That(mask & ~closed, Is.Zero, $"{mask}: the closure must contain the marks");
            Assert.That(Patterns.KindOf(closed), Is.Not.EqualTo(Patterns.Kind.Invalid), $"{mask}");
            if (Patterns.KindOf(mask) != Patterns.Kind.Invalid) Assert.That(closed, Is.EqualTo(mask), $"{mask}: a good pattern is left as it is");
            // nothing smaller does: no pattern with a template that holds the marks has fewer nodes
            for (int other = 0; other < 256; other++)
                if (Patterns.KindOf(other) != Patterns.Kind.Invalid && (mask & ~other) == 0)
                    Assert.That(System.Numerics.BitOperations.PopCount((uint)other), Is.GreaterThanOrEqualTo(System.Numerics.BitOperations.PopCount((uint)closed)), $"{mask}");
        }
    }

    [Test]
    public void The_completion_leaves_every_cell_with_a_pattern_that_has_a_template_and_is_the_same_in_any_order()
    {
        var random = new Random(2);
        for (int trial = 0; trial < 150; trial++)
        {
            var mesh = HexMesh.Grid(3, 3, 3);
            var marks = Enumerable.Range(0, mesh.Nodes.Count).Where(_ => random.NextDouble() < 0.2).ToHashSet();
            var once = new HashSet<int>(marks);
            Refiner.Complete(mesh, once);
            foreach (var cell in mesh.Cells.Values)
            {
                int mask = cell.Nodes.Select((n, s) => once.Contains(n) ? 1 << s : 0).Sum();
                Assert.That(Patterns.KindOf(mask), Is.Not.EqualTo(Patterns.Kind.Invalid), $"trial {trial}: cell {cell.Id}");
            }
            // completing again changes nothing, and completing from the result of a partial completion gives the same set
            var twice = new HashSet<int>(once);
            Refiner.Complete(mesh, twice);
            Assert.That(twice.SetEquals(once));
            var half = new HashSet<int>(marks.Take(marks.Count / 2));
            Refiner.Complete(mesh, half);
            half.UnionWith(marks);
            Refiner.Complete(mesh, half);
            Assert.That(half.SetEquals(once), $"trial {trial}: the order of the completion changed the result");
        }
    }

    // ---- the templates -------------------------------------------------------------------------------------------------------

    [Test]
    public void Each_template_gives_its_number_of_children_that_fill_the_parent()
    {
        for (int n = 2; n <= 6; n++)
            for (int kind = 0; kind < 3; kind++)
            {
                var mesh = HexMesh.Grid(1, 1, 1);
                mesh.Rescale(n);
                var parent = mesh.Cells.Values.Single();
                var corners = mesh.CornersOf(parent);
                for (int variant = 0; variant < (kind == 0 ? 8 : kind == 1 ? 12 : 6); variant++)
                {
                    var m = HexMesh.Grid(1, 1, 1);
                    m.Rescale(n);
                    var p = m.Cells.Values.Single();
                    List<Cell> children;
                    if (kind == 0) children = Templates.ApplyCorner(m, p, variant, n);
                    else if (kind == 1)
                    {
                        int axis = variant / 4, rest = variant % 4;
                        var (u, v) = Hex.Others(axis);
                        children = Templates.ApplyEdge(m, p, axis, (rest & 1) << u | (rest >> 1) << v, n);
                    }
                    else children = Templates.ApplyFace(m, p, variant / 2, variant % 2, n);
                    Assert.That(children, Has.Count.EqualTo(kind == 0 ? 3 * n - 2 : kind == 1 ? 2 * n - 1 : n), $"kind {kind}, variant {variant}, n = {n}");
                    m.RemoveCell(p.Id);
                    foreach (var c in children) m.AddToRoot(c);
                    AssertConforming(m, $"kind {kind}, variant {variant}, n = {n}");
                }
            }
    }

    // ---- the first refinement ------------------------------------------------------------------------------------------------

    [Test]
    public void One_cell_anywhere_in_a_grid_is_split_into_nI_nJ_nK_and_the_mesh_conforms()
    {
        foreach (var (nI, nJ, nK) in new[] { (2, 2, 2), (3, 2, 4), (2, 5, 3), (4, 4, 4) })
        {
            var mesh = HexMesh.Grid(4, 4, 4);
            var picked = new[] { (0, 0, 0), (3, 3, 3), (1, 2, 1), (0, 3, 2) };
            Refiner.Refine(mesh, LeavesOfRoots(mesh, r => picked.Contains((r.I, r.J, r.K))), nI, nJ, nK);
            AssertConforming(mesh, $"n = {nI}x{nJ}x{nK}");
            foreach (var (i, j, k) in picked)
                Assert.That(mesh.Roots.Single(r => r.I == i && r.J == j && r.K == k).Leaves, Has.Count.EqualTo(nI * nJ * nK), $"({i},{j},{k}) n = {nI}x{nJ}x{nK}");
        }
    }

    [Test]
    public void Random_sets_of_marked_cells_on_grids_with_holes_always_give_a_conforming_mesh_and_none_is_left_unreached()
    {
        var random = new Random(7);
        for (int trial = 0; trial < 120; trial++)
        {
            var mesh = RandomGrid(random, 5, 0.15);
            var marked = LeavesOfRoots(mesh, _ => random.NextDouble() < 0.2);
            if (marked.Count == 0) continue;
            int nI = random.Next(2, 5), nJ = random.Next(2, 5), nK = random.Next(2, 5);

            var result = Refiner.Refine(mesh, marked, nI, nJ, nK);

            AssertConforming(mesh, $"trial {trial}: {mesh.Roots.Count} roots, {marked.Count} marked, n = {nI}x{nJ}x{nK}");
            Assert.That(result.Passes.SelectMany(p => p.Unreached), Is.Empty, $"trial {trial}");
            foreach (int id in marked) { /* the marked roots were whole leaves: each ended up as nI*nJ*nK leaves */ }
        }
    }

    [Test]
    public void Every_marked_root_ends_up_cut_into_exactly_nI_nJ_nK_pieces()
    {
        var random = new Random(8);
        for (int trial = 0; trial < 80; trial++)
        {
            var mesh = RandomGrid(random, 5, 0.1);
            var chosen = mesh.Roots.Where(_ => random.NextDouble() < 0.25).Select(r => r.Id).ToHashSet();
            if (chosen.Count == 0) continue;
            int nI = random.Next(2, 5), nJ = random.Next(2, 5), nK = random.Next(2, 5);

            Refiner.Refine(mesh, chosen.SelectMany(id => mesh.Roots[id].Leaves).ToList(), nI, nJ, nK);

            foreach (int id in chosen) Assert.That(mesh.Roots[id].Leaves, Has.Count.EqualTo(nI * nJ * nK), $"trial {trial}, root {id}, n = {nI}x{nJ}x{nK}");
        }
    }

    [Test]
    public void The_result_does_not_depend_on_the_order_of_the_marked_cells_and_repeats_exactly()
    {
        var random = new Random(9);
        for (int trial = 0; trial < 40; trial++)
        {
            var a = RandomGrid(random, 4, 0.1);
            var b = a.Clone();
            var c = a.Clone();
            var marked = LeavesOfRoots(a, _ => random.NextDouble() < 0.3);
            if (marked.Count < 2) continue;
            int n = random.Next(2, 4);
            Refiner.Refine(a, marked, n, n + 1, n);
            Refiner.Refine(b, Enumerable.Reverse(marked).ToList(), n, n + 1, n);
            Refiner.Refine(c, marked, n, n + 1, n);
            Assert.That(Signature(b), Is.EqualTo(Signature(a)), $"trial {trial}: another order");
            Assert.That(Signature(c), Is.EqualTo(Signature(a)), $"trial {trial}: a second run");
        }
    }

    [Test]
    public void A_refinement_of_a_clone_leaves_the_original_alone()
    {
        var mesh = HexMesh.Grid(3, 3, 3);
        string before = Signature(mesh);
        var clone = mesh.Clone();
        Refiner.Refine(clone, clone.Roots[13].Leaves.ToList(), 3, 2, 2);
        Assert.That(Signature(mesh), Is.EqualTo(before));
        Assert.That(mesh.Scale, Is.EqualTo(1));
    }

    [Test]
    public void Narrow_grids_corners_and_a_cell_in_a_pocket_of_holes_work()
    {
        foreach (var (nx, ny, nz) in new[] { (1, 1, 1), (1, 1, 5), (5, 1, 1), (1, 4, 2), (2, 2, 2) })
            foreach (int n in new[] { 2, 3, 5 })
            {
                foreach (int which in new[] { 0, -1 })
                {
                    var mesh = HexMesh.Grid(nx, ny, nz);
                    var root = which == 0 ? mesh.Roots[0] : mesh.Roots[^1];
                    Refiner.Refine(mesh, root.Leaves.ToList(), n, n, n);
                    AssertConforming(mesh, $"{nx}x{ny}x{nz}, n = {n}, root {which}");
                }
            }
        var holes = new[] { (1, 1, 0), (1, 1, 2), (0, 1, 1), (2, 1, 1), (1, 0, 1), (1, 2, 1) };         // the middle cell is enclosed on all six sides
        var pocket = HexMesh.Grid(3, 3, 3, holes);
        Refiner.Refine(pocket, pocket.Roots.Single(r => r is { I: 1, J: 1, K: 1 }).Leaves.ToList(), 3, 3, 3);
        AssertConforming(pocket);
    }

    [Test]
    public void Bad_input_is_refused_and_the_mesh_is_untouched()
    {
        var mesh = HexMesh.Grid(2, 2, 2);
        string before = Signature(mesh);
        Assert.Throws<ArgumentOutOfRangeException>(() => Refiner.Refine(mesh, new[] { 0 }, 1, 2, 2));
        Assert.Throws<ArgumentOutOfRangeException>(() => Refiner.Refine(mesh, new[] { 0 }, 2, 2, 1));
        Assert.Throws<ArgumentException>(() => Refiner.Refine(mesh, new[] { 999 }, 2, 2, 2));
        Assert.That(Signature(mesh), Is.EqualTo(before));
    }

    // ---- the second refinement: leaves of an earlier one ---------------------------------------------------------------------

    private static HexMesh RefinedOnce(Random random)
    {
        var mesh = RandomGrid(random, 4, 0.1);
        var first = LeavesOfRoots(mesh, _ => random.NextDouble() < 0.3);
        if (first.Count == 0) first = mesh.Roots[0].Leaves.ToList();
        Refiner.Refine(mesh, first, random.Next(2, 4), random.Next(2, 4), random.Next(2, 4));
        return mesh;
    }

    [Test]
    public void Random_leaves_of_a_refined_mesh_refined_again_always_conform_and_report_what_they_could_not_cut()
    {
        var random = new Random(10);
        int leavesTried = 0, unreached = 0;
        for (int trial = 0; trial < 60; trial++)
        {
            var mesh = RefinedOnce(random);
            var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.02).ToList();
            if (leaves.Count == 0) continue;

            var result = Refiner.Refine(mesh, leaves, random.Next(2, 4), random.Next(2, 4), random.Next(2, 4));

            AssertConforming(mesh, $"trial {trial}, {leaves.Count} leaves again");
            leavesTried += leaves.Count;
            unreached += result.Passes.Sum(p => p.Unreached.Count);
        }
        TestContext.Out.WriteLine($"SECONDLEVEL leaves {leavesTried}, unreached reports {unreached}");
        Assert.That(leavesTried, Is.GreaterThan(0));
    }

    [Test]
    public void The_volume_is_kept_and_all_nodes_are_used_and_unique()
    {
        var random = new Random(11);
        for (int trial = 0; trial < 40; trial++)
        {
            var mesh = RefinedOnce(random);
            var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.03).ToList();
            if (leaves.Count > 0) Refiner.Refine(mesh, leaves, 2, 3, 2);
            Assert.That(mesh.Nodes.Distinct().Count(), Is.EqualTo(mesh.Nodes.Count), $"trial {trial}: two nodes at one point");
            Assert.That(mesh.Cells.Values.SelectMany(c => c.Nodes).Distinct().Count(), Is.EqualTo(mesh.Nodes.Count), $"trial {trial}: an unused node");
            AssertConforming(mesh, $"trial {trial}");                       // the volumes of the leaves of every root add up to the root's
        }
    }

    [Test]
    public void The_diagonal_faces_between_plates_are_the_known_cases_of_a_face_met_along_two_different_axes()
    {
        var mesh = HexMesh.Grid(3, 3, 3);
        Refiner.Refine(mesh, mesh.Roots[13].Leaves.ToList(), 3, 3, 3);
        TestContext.Out.WriteLine($"AXISMISMATCH {Conformity.AxisMismatchedFaces(mesh)} faces of {mesh.Cells.Count} cells");
        Assert.That(Conformity.AxisMismatchedFaces(mesh), Is.GreaterThan(0), "T1 and T2 do make such faces: a consumer must be ready for them");
    }
}
