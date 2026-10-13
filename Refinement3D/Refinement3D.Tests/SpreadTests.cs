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
        var result = Refiner.Refine(mesh, mesh.Roots[0].Leaves.ToList(), 2, 2, 2, expandTransitions: true);
        Assert.That(Conformity.Check(mesh), Is.Empty);
        Assert.That(Refined(mesh).Count, Is.GreaterThan(8));
        Assert.That(result.Passes.SelectMany(p => p.Unreached), Is.Empty);
    }

    [Test]
    public void Both_variants_conform_and_cut_every_chosen_root_exactly_on_random_grids()
    {
        foreach (bool all in new[] { false, true })
        {
            var random = new Random(all ? 101 : 100);
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

                var result = Refiner.Refine(mesh, chosen.SelectMany(id => mesh.Roots[id].Leaves).ToList(), nI, nJ, nK, all);

                var problems = Conformity.Check(mesh);
                Assert.That(problems, Is.Empty, $"all={all}, trial {trial}\n" + string.Join("\n", problems.Take(5)));
                Assert.That(result.Passes.SelectMany(p => p.Unreached), Is.Empty, $"all={all}, trial {trial}");
                foreach (int id in chosen) Assert.That(mesh.Roots[id].Leaves, Has.Count.EqualTo(nI * nJ * nK), $"all={all}, trial {trial}, root {id}");
            }
        }
    }

    [Test]
    public void Both_variants_conform_when_leaves_of_an_earlier_refinement_are_refined_again()
    {
        foreach (bool all in new[] { false, true })
        {
            var random = new Random(all ? 201 : 200);
            for (int trial = 0; trial < 40; trial++)
            {
                var mesh = HexMesh.Grid(3, 3, 3);
                Refiner.Refine(mesh, mesh.Roots.Where(_ => random.NextDouble() < 0.3).SelectMany(r => r.Leaves).ToList(), 2, 2, 2, all);
                var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.03).ToList();
                if (leaves.Count == 0) continue;

                Refiner.Refine(mesh, leaves, random.Next(2, 4), random.Next(2, 4), random.Next(2, 4), all);

                var problems = Conformity.Check(mesh);
                Assert.That(problems, Is.Empty, $"all={all}, trial {trial}\n" + string.Join("\n", problems.Take(5)));
            }
        }
    }
}
