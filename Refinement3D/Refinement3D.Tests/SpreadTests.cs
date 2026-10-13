using Refinement3D.Core;

namespace Refinement3D.Tests;

/// <summary>How far one refinement spreads. The book adds everything that was refined to M after each pass, which makes the next pass refine the transition layers too (a corner cell touches 48 coarse cells); the default here adds only what comes from the user's cells.</summary>
public class SpreadTests
{
    private static List<Root> Refined(HexMesh mesh) => mesh.Roots.Where(r => r.Leaves.Count > 1).ToList();

    [Test]
    public void A_single_corner_cell_touches_only_the_2_by_2_by_2_block_it_is_in()
    {
        var mesh = HexMesh.Grid(7, 7, 7);
        Refiner.Refine(mesh, mesh.Roots[0].Leaves.ToList(), 2, 2, 2);
        Assert.That(Conformity.Check(mesh), Is.Empty);
        var touched = Refined(mesh);
        Assert.That(touched, Has.Count.EqualTo(8));
        Assert.That(touched.All(r => r.I <= 1 && r.J <= 1 && r.K <= 1));
    }

    [Test]
    public void A_single_interior_cell_touches_the_cells_round_it_and_nothing_further()
    {
        foreach (var n in new[] { 2, 3, 4 })
        {
            var mesh = HexMesh.Grid(7, 7, 7);
            Refiner.Refine(mesh, mesh.Roots.Single(r => (r.I, r.J, r.K) == (3, 3, 3)).Leaves.ToList(), n, n, n);
            Assert.That(Conformity.Check(mesh), Is.Empty, $"n = {n}");
            var touched = Refined(mesh);
            Assert.That(touched.Count, Is.LessThanOrEqualTo(27), $"n = {n}");
            Assert.That(touched.All(r => Math.Abs(r.I - 3) <= 1 && Math.Abs(r.J - 3) <= 1 && Math.Abs(r.K - 3) <= 1), $"n = {n}");
        }
    }

    [Test]
    public void The_book_variant_spreads_further_and_is_still_conforming()
    {
        var mesh = HexMesh.Grid(7, 7, 7);
        var result = Refiner.Refine(mesh, mesh.Roots[0].Leaves.ToList(), 2, 2, 2, transitionDepth: 2);
        Assert.That(Conformity.Check(mesh), Is.Empty);
        Assert.That(Refined(mesh).Count, Is.GreaterThan(8));
        Assert.That(result.Passes.SelectMany(p => p.Unreached), Is.Empty);
    }

    [Test]
    public void Both_variants_conform_and_cut_every_chosen_root_exactly_on_random_grids()
    {
        foreach (int depth in new[] { 0, 1, 2 })
        {
            var random = new Random(100 + depth);
            for (int trial = 0; trial < 60; trial++)
            {
                int nx = random.Next(1, 5), ny = random.Next(1, 5), nz = random.Next(1, 5);
                var holes = new List<(int, int, int)>();
                for (int i = 0; i < nx; i++) for (int j = 0; j < ny; j++) for (int k = 0; k < nz; k++) if (random.NextDouble() < 0.1) holes.Add((i, j, k));
                if (holes.Count == nx * ny * nz) holes.RemoveAt(0);
                var mesh = HexMesh.Grid(nx, ny, nz, holes);
                var chosen = mesh.Roots.Where(_ => random.NextDouble() < 0.25).Select(r => r.Id).ToHashSet();
                if (chosen.Count == 0) continue;
                int nI = random.Next(2, 5), nJ = random.Next(2, 5), nK = random.Next(2, 5);

                var result = Refiner.Refine(mesh, chosen.SelectMany(id => mesh.Roots[id].Leaves).ToList(), nI, nJ, nK, depth);

                var problems = Conformity.Check(mesh);
                Assert.That(problems, Is.Empty, $"depth={depth}, trial {trial}\n" + string.Join("\n", problems.Take(5)));
                Assert.That(result.Passes.SelectMany(p => p.Unreached), Is.Empty, $"depth={depth}, trial {trial}");
                foreach (int id in chosen) Assert.That(mesh.Roots[id].Leaves, Has.Count.EqualTo(nI * nJ * nK), $"depth={depth}, trial {trial}, root {id}");
            }
        }
    }

    [Test]
    public void Both_variants_conform_when_leaves_of_an_earlier_refinement_are_refined_again()
    {
        foreach (int depth in new[] { 0, 1, 2 })
        {
            var random = new Random(200 + depth);
            for (int trial = 0; trial < 40; trial++)
            {
                var mesh = HexMesh.Grid(3, 3, 3);
                Refiner.Refine(mesh, mesh.Roots.Where(_ => random.NextDouble() < 0.3).SelectMany(r => r.Leaves).ToList(), 2, 2, 2, depth);
                var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.03).ToList();
                if (leaves.Count == 0) continue;

                Refiner.Refine(mesh, leaves, random.Next(2, 4), random.Next(2, 4), random.Next(2, 4), depth);

                var problems = Conformity.Check(mesh);
                Assert.That(problems, Is.Empty, $"depth={depth}, trial {trial}\n" + string.Join("\n", problems.Take(5)));
            }
        }
    }
}

/// <summary>Many refinements one after another make the lattice very fine; that must work while the numbers fit and be refused cleanly after.</summary>
public class DepthTests
{
    private static string Signature(HexMesh mesh) =>
        string.Join(";", mesh.Cells.Values.Select(c => string.Join(",", c.Nodes.Select(mesh.PointOf).Select(p => $"{p.X}:{p.Y}:{p.Z}"))).OrderBy(s => s, StringComparer.Ordinal));

    [Test]
    public void Refining_the_same_corner_again_and_again_stays_conforming_until_the_lattice_is_too_fine_and_then_is_refused_untouched()
    {
        var mesh = HexMesh.Grid(3, 3, 3);
        int rounds = 0;
        while (true)
        {
            string before = Signature(mesh);
            var leaf = mesh.Cells.Values.Where(c => c.Nodes.Select(mesh.PointOf).Min(p => p.X + p.Y + p.Z) == 0).OrderBy(c => c.Nodes.Select(mesh.PointOf).Max(p => p.X + p.Y + p.Z)).First();
            try { Refiner.Refine(mesh, new[] { leaf.Id }, 3, 3, 3); }
            catch (InvalidOperationException)
            {
                Assert.That(Signature(mesh), Is.EqualTo(before), "a refused refinement must not change the mesh");
                break;
            }
            Assert.That(Conformity.Check(mesh), Is.Empty, $"round {rounds}");
            Assert.That(++rounds, Is.LessThan(40), "the lattice never got too fine");
        }
        Assert.That(rounds, Is.GreaterThanOrEqualTo(4), "at least a few rounds of n = 3 must be possible");
    }

    [Test]
    public void The_coordinates_never_pass_the_limit_the_checks_can_handle()
    {
        var mesh = HexMesh.Grid(2, 2, 2);
        for (int round = 0; round < 6; round++)
        {
            try { Refiner.Refine(mesh, new[] { mesh.Cells.Keys.First() }, 8, 8, 8); }
            catch (InvalidOperationException) { break; }
            Assert.That(mesh.Nodes.Max(p => Math.Max(p.X, Math.Max(p.Y, p.Z))), Is.LessThanOrEqualTo(1L << 40));
        }
    }
}

public class TransitionDepthTests
{
    private static int Touched(int depth, (int, int, int) at)
    {
        var mesh = HexMesh.Grid(9, 9, 9);
        Refiner.Refine(mesh, mesh.Roots.Single(r => (r.I, r.J, r.K) == at).Leaves.ToList(), 2, 2, 2, depth);
        Assert.That(Conformity.Check(mesh), Is.Empty, $"depth {depth}");
        return mesh.Roots.Count(r => r.Leaves.Count > 1);
    }

    [Test]
    public void A_deeper_transition_zone_touches_more_coarse_cells_one_step_at_a_time()
    {
        foreach (var at in new[] { (0, 0, 0), (4, 4, 4), (3, 5, 4) })
        {
            int d0 = Touched(0, at), d1 = Touched(1, at), d2 = Touched(2, at);
            TestContext.Out.WriteLine($"DEPTH {at}: depth 0 touches {d0} coarse cells, depth 1 {d1}, depth 2 {d2}");
            Assert.That(d0, Is.LessThan(d1), $"{at}");
            Assert.That(d1, Is.LessThan(d2), $"{at}");
        }
    }

    [Test]
    public void A_depth_outside_0_to_2_is_refused_and_the_mesh_is_untouched()
    {
        var mesh = HexMesh.Grid(2, 2, 2);
        Assert.Throws<ArgumentOutOfRangeException>(() => Refiner.Refine(mesh, mesh.Roots[0].Leaves.ToList(), 2, 2, 2, 3));
        Assert.Throws<ArgumentOutOfRangeException>(() => Refiner.Refine(mesh, mesh.Roots[0].Leaves.ToList(), 2, 2, 2, -1));
        Assert.That(mesh.Cells, Has.Count.EqualTo(8));
    }
}

/// <summary>A big selection must not overflow the stack of a thread (the search for the seams once did) and must stay conforming.</summary>
public class BigSelectionTests
{
    [Test]
    public void A_block_of_125_coarse_cells_cut_in_3_by_3_by_3_conforms_and_needs_no_deep_recursion()
    {
        var mesh = HexMesh.Grid(9, 9, 9);
        var block = mesh.Roots.Where(r => r.I is >= 2 and < 7 && r.J is >= 2 and < 7 && r.K is >= 2 and < 7).SelectMany(r => r.Leaves).ToList();
        Assert.That(block, Has.Count.EqualTo(125));

        // run on a thread with a small stack: a recursion thousands of levels deep would not survive here
        Refinement3D.Core.RefineResult? result = null;
        var thread = new Thread(() => result = Refiner.Refine(mesh, block, 3, 3, 3), 256 * 1024);
        thread.Start();
        thread.Join();

        Assert.That(result, Is.Not.Null);
        var problems = Conformity.Check(mesh);
        Assert.That(problems, Is.Empty, string.Join("\n", problems.Take(5)));
        Assert.That(result!.Passes.SelectMany(p => p.Unreached), Is.Empty);
        foreach (var root in mesh.Roots.Where(r => r.I is >= 2 and < 7 && r.J is >= 2 and < 7 && r.K is >= 2 and < 7)) Assert.That(root.Leaves, Has.Count.EqualTo(27));
    }

    [Test]
    public void A_second_refinement_of_a_whole_block_of_leaves_conforms_on_a_small_stack_too()
    {
        var mesh = HexMesh.Grid(6, 6, 6);
        Refiner.Refine(mesh, mesh.Roots.Where(r => r.I is >= 1 and < 5 && r.J is >= 1 and < 5 && r.K is >= 1 and < 5).SelectMany(r => r.Leaves).ToList(), 2, 2, 2);
        var inside = mesh.Cells.Values.Where(c => mesh.CornersOf(c).All(p => p.X >= 2 * mesh.Scale / 6 * 2 && p.X <= 4 * mesh.Scale && p.Y >= 2 * mesh.Scale / 6 * 2 && p.Y <= 4 * mesh.Scale && p.Z >= 2 * mesh.Scale / 6 * 2 && p.Z <= 4 * mesh.Scale)).Select(c => c.Id).ToList();
        Assert.That(inside, Is.Not.Empty);

        var thread = new Thread(() => Refiner.Refine(mesh, inside, 2, 2, 2), 256 * 1024);
        thread.Start();
        thread.Join();

        Assert.That(Conformity.Check(mesh), Is.Empty);
    }
}
