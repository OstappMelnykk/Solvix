using Refinement3D.Core;

namespace Refinement3D.Tests;

public class SmoothingTests
{
    private static HexMesh Refined(int seed, bool deep = false)
    {
        var random = new Random(seed);
        var mesh = HexMesh.Grid(random.Next(2, 4), random.Next(2, 4), random.Next(2, 4));
        Refiner.Refine(mesh, mesh.Roots.Where(_ => random.NextDouble() < 0.3).SelectMany(r => r.Leaves).DefaultIfEmpty(mesh.Roots[0].Leaves[0]).ToList(), random.Next(2, 4), random.Next(2, 4), random.Next(2, 4));
        if (deep)
        {
            var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.03).ToList();
            if (leaves.Count > 0) Refiner.Refine(mesh, leaves, 2, 2, 2);
        }
        return mesh;
    }

    [Test]
    public void The_nodes_on_the_surface_do_not_move_at_all_by_default()
    {
        for (int seed = 0; seed < 10; seed++)
        {
            var mesh = Refined(seed);
            var constraint = Smoothing.SurfaceConstraints(mesh);
            var before = Smoothing.Lattice(mesh);

            var result = Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: 30, Relaxation: 0.6));

            for (int i = 0; i < constraint.Length; i++)
                if (constraint[i] != 0)
                    for (int a = 0; a < 3; a++) Assert.That(result.Positions[i * 3 + a], Is.EqualTo(before[i * 3 + a]), $"seed {seed}, surface node {i}, axis {a}");
        }
    }

    [Test]
    public void With_sliding_a_surface_node_keeps_the_coordinates_its_face_pins_and_a_corner_does_not_move()
    {
        for (int seed = 0; seed < 10; seed++)
        {
            var mesh = Refined(seed);
            var constraint = Smoothing.SurfaceConstraints(mesh);
            var before = Smoothing.Lattice(mesh);

            var result = Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: 30, Relaxation: 0.6, SlideOnSurface: true));

            for (int i = 0; i < constraint.Length; i++)
                for (int a = 0; a < 3; a++)
                    if ((constraint[i] >> a & 1) == 1) Assert.That(result.Positions[i * 3 + a], Is.EqualTo(before[i * 3 + a]), $"seed {seed}, node {i}, axis {a}");
        }
    }

    [Test]
    public void No_cell_is_turned_inside_out_and_the_total_volume_is_kept()
    {
        foreach (bool slide in new[] { false, true })
            for (int seed = 0; seed < 10; seed++)
            {
                var mesh = Refined(seed, deep: seed % 2 == 0);
                var before = Smoothing.Lattice(mesh);
                double volume = Smoothing.TotalVolume(mesh, before);

                var result = Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: 40, Relaxation: 0.7, Density: 0.5, SlideOnSurface: slide));

                Assert.That(result.After.Inverted, Is.Zero, $"slide {slide}, seed {seed}");
                Assert.That(result.After.Min, Is.GreaterThan(0), $"slide {slide}, seed {seed}");
                Assert.That(Smoothing.TotalVolume(mesh, result.Positions), Is.EqualTo(volume).Within(1e-9 * Math.Max(1, volume)), $"slide {slide}, seed {seed}: the shape of the body changed");
            }
    }

    [Test]
    public void The_worst_cell_never_gets_worse_and_with_sliding_it_gets_clearly_better()
    {
        double worstBefore = 0, worstSlide = 0, meanBefore = 0, meanSlide = 0;
        int n = 0;
        for (int seed = 0; seed < 12; seed++)
        {
            var mesh = Refined(seed, deep: seed % 2 == 0);
            foreach (bool slide in new[] { false, true })
            {
                var result = Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: 40, Relaxation: 0.5, Density: 0.5, SlideOnSurface: slide));
                Assert.That(result.After.MinScaled, Is.GreaterThanOrEqualTo(result.Before.MinScaled - 1e-9), $"seed {seed}, slide {slide}: the worst cell got worse");
                Assert.That(result.After.MeanScaled, Is.GreaterThanOrEqualTo(result.Before.MeanScaled - 1e-9), $"seed {seed}, slide {slide}: the mean quality got worse");
                if (slide) { worstSlide += result.After.MinScaled; meanSlide += result.After.MeanScaled; }
            }
            var before = Smoothing.QualityOf(mesh, Smoothing.Lattice(mesh));
            worstBefore += before.MinScaled;
            meanBefore += before.MeanScaled;
            n++;
        }
        TestContext.Out.WriteLine($"SMOOTH worst scaled Jacobian {worstBefore / n:0.000} -> {worstSlide / n:0.000}, mean {meanBefore / n:0.000} -> {meanSlide / n:0.000} (sliding)");
        Assert.That(worstSlide, Is.GreaterThan(worstBefore * 1.15), "sliding must clearly improve the worst cells");
        Assert.That(meanSlide, Is.GreaterThanOrEqualTo(meanBefore - 1e-9), "and must not make the mean worse");
    }

    [Test]
    public void One_cell_refined_three_ways_in_the_middle_of_a_grid_gets_better_in_the_worst_the_mean_and_the_poor_count()
    {
        var mesh = HexMesh.Grid(4, 4, 4);
        Refiner.Refine(mesh, mesh.Roots.Single(r => (r.I, r.J, r.K) == (2, 2, 2)).Leaves.ToList(), 3, 3, 3);

        var result = Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: 40, Relaxation: 0.5, Density: 0.5, SlideOnSurface: true));

        TestContext.Out.WriteLine($"MIDDLE worst {result.Before.MinScaled:0.000}->{result.After.MinScaled:0.000}, mean {result.Before.MeanScaled:0.000}->{result.After.MeanScaled:0.000}, poor {result.Before.Poor}->{result.After.Poor}");
        Assert.That(result.After.MinScaled, Is.GreaterThanOrEqualTo(result.Before.MinScaled - 1e-9));
        Assert.That(result.After.MeanScaled, Is.GreaterThanOrEqualTo(result.Before.MeanScaled - 1e-9));
        Assert.That(result.After.Poor, Is.LessThanOrEqualTo(result.Before.Poor));
    }

    [Test]
    public void A_plain_grid_is_left_as_it_is_and_nothing_changes_with_zero_passes()
    {
        var grid = HexMesh.Grid(3, 3, 3);
        var result = Smoothing.Smooth(grid, new SmoothingOptions(Iterations: 20));
        Assert.That(result.Moved, Is.Zero, "a regular grid is already smooth");
        var mesh = Refined(3);
        var none = Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: 0));
        Assert.That(none.Moved, Is.Zero);
        Assert.That(none.Positions, Is.EqualTo(Smoothing.Lattice(mesh)));
    }

    [Test]
    public void The_smoothing_reports_every_pass_and_can_be_stopped_with_what_is_done_kept()
    {
        var mesh = Refined(4);
        var passes = new List<int>();
        var snapshots = new List<double[]>();
        var full = Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: 30, Relaxation: 0.3, SlideOnSurface: true), (pass, pos) => { passes.Add(pass); snapshots.Add((double[])pos.Clone()); });
        Assert.That(passes, Is.EqualTo(Enumerable.Range(1, passes.Count)), "the passes are reported one after another");
        Assert.That(passes.Count, Is.InRange(1, 30));

        using var stop = new CancellationTokenSource();
        var seen = 0;
        var partial = Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: 30, Relaxation: 0.3, SlideOnSurface: true), (pass, _) => { seen = pass; if (pass == 3) stop.Cancel(); }, stop.Token);
        Assert.That(seen, Is.EqualTo(Math.Min(3, passes.Count)), "it stops after the pass it was in when the stop came");
        Assert.That(partial.Positions, Is.EqualTo(snapshots[Math.Min(3, passes.Count) - 1]), "what is returned is the state after that pass");
        Assert.That(partial.After.Inverted, Is.Zero);
    }

    [Test]
    public void Bad_settings_are_refused()
    {
        var mesh = HexMesh.Grid(2, 2, 2);
        Assert.Throws<ArgumentOutOfRangeException>(() => Smoothing.Smooth(mesh, new SmoothingOptions(Relaxation: 0)));
        Assert.Throws<ArgumentOutOfRangeException>(() => Smoothing.Smooth(mesh, new SmoothingOptions(Relaxation: 1.5)));
        Assert.Throws<ArgumentOutOfRangeException>(() => Smoothing.Smooth(mesh, new SmoothingOptions(Density: 2)));
        Assert.Throws<ArgumentOutOfRangeException>(() => Smoothing.Smooth(mesh, new SmoothingOptions(Iterations: -1)));
    }
}
