using Refinement3D.Core;

namespace Refinement3D.Tests;

/// <summary>The optimization smoothing (and going on from an earlier result): what it must keep, what it must give, that it is repeatable.</summary>
public class OptimizationTests
{
    private static HexMesh Middle(int depth = 0)
    {
        var mesh = HexMesh.Grid(5, 5, 5);
        Refiner.Refine(mesh, mesh.Roots.Single(r => (r.I, r.J, r.K) == (2, 2, 2)).Leaves.ToList(), 3, 3, 3, depth);
        return mesh;
    }

    private static HexMesh Random(int seed)
    {
        var random = new System.Random(seed);
        var mesh = HexMesh.Grid(random.Next(2, 4), random.Next(2, 4), random.Next(2, 4));
        Refiner.Refine(mesh, mesh.Roots.Where(_ => random.NextDouble() < 0.3).SelectMany(r => r.Leaves).DefaultIfEmpty(mesh.Roots[0].Leaves[0]).ToList(), random.Next(2, 4), random.Next(2, 4), random.Next(2, 4));
        return mesh;
    }

    [Test]
    public void It_lifts_the_worst_cells_far_more_than_the_Laplacian_does()
    {
        var mesh = Middle();
        var laplace = Smoothing.Smooth(mesh, new SmoothingOptions(40, 0.5, 0.5, true));
        var optimized = Smoothing.Smooth(mesh, new SmoothingOptions(0, 0.5, 0.5, true, OptimizationPasses: 20));
        var both = Smoothing.Smooth(mesh, new SmoothingOptions(40, 0.5, 0.5, true, OptimizationPasses: 20));
        TestContext.Out.WriteLine($"OPTIMIZATION worst {laplace.Before.MinScaled:0.000}: Laplacian {laplace.After.MinScaled:0.000}, optimization {optimized.After.MinScaled:0.000}, both {both.After.MinScaled:0.000}; poor {laplace.Before.Poor} -> {laplace.After.Poor} / {optimized.After.Poor} / {both.After.Poor}");
        Assert.That(optimized.After.MinScaled, Is.GreaterThan(laplace.After.MinScaled * 2.5), "the optimization must clearly beat the Laplacian on the worst cell");
        Assert.That(optimized.After.MinScaled, Is.GreaterThan(0.3));
        Assert.That(both.After.MinScaled, Is.GreaterThanOrEqualTo(optimized.After.MinScaled - 0.05), "the Laplacian before it must not hurt");
        Assert.That(optimized.After.Poor, Is.LessThan(optimized.Before.Poor));
    }

    [Test]
    public void It_keeps_the_surface_and_the_volume_and_inverts_nothing_and_never_makes_the_worst_cell_or_the_sum_of_the_barriers_worse()
    {
        foreach (bool slide in new[] { false, true })
            for (int seed = 0; seed < 8; seed++)
            {
                var mesh = Random(seed);
                var constraint = Smoothing.SurfaceConstraints(mesh);
                var lattice = Smoothing.Lattice(mesh);
                double volume = Smoothing.TotalVolume(mesh, lattice);

                var result = Smoothing.Smooth(mesh, new SmoothingOptions(10, 0.5, 0.5, slide, OptimizationPasses: 15));

                Assert.That(result.After.Inverted, Is.Zero, $"slide {slide}, seed {seed}");
                Assert.That(result.After.MinScaled, Is.GreaterThanOrEqualTo(result.Before.MinScaled - 1e-9), $"slide {slide}, seed {seed}: the worst cell got worse");
                Assert.That(Smoothing.BarrierSum(mesh, result.Positions), Is.LessThanOrEqualTo(Smoothing.BarrierSum(mesh, lattice) + 1e-9), $"slide {slide}, seed {seed}: the sum of the barriers got bigger");
                Assert.That(result.After.MeanScaled, Is.GreaterThanOrEqualTo(result.Before.MeanScaled - 0.03), $"slide {slide}, seed {seed}: the mean fell a lot");
                Assert.That(Smoothing.TotalVolume(mesh, result.Positions), Is.EqualTo(volume).Within(1e-9 * Math.Max(1, volume)), $"slide {slide}, seed {seed}: the shape changed");
                for (int i = 0; i < constraint.Length; i++)
                    for (int a = 0; a < 3; a++)
                        if (constraint[i] != 0 && (!slide || (constraint[i] >> a & 1) == 1))
                            Assert.That(result.Positions[i * 3 + a], Is.EqualTo(lattice[i * 3 + a]), $"slide {slide}, seed {seed}, node {i}, axis {a}: a surface node left its place");
            }
    }

    [Test]
    public void The_result_is_the_same_every_time_whatever_the_number_of_processors()
    {
        var mesh = Middle(depth: 2);
        var options = new SmoothingOptions(10, 0.5, 0.5, true, OptimizationPasses: 5);
        var first = Smoothing.Smooth(mesh, options);
        var second = Smoothing.Smooth(mesh, options);
        Assert.That(second.Positions, Is.EqualTo(first.Positions), "two runs must agree exactly");

        var previous = ThreadPool.SetMinThreads(1, 1);
        var constrained = Task.Factory.StartNew(() => Smoothing.Smooth(mesh, options), CancellationToken.None, TaskCreationOptions.None, new SingleThreadScheduler()).Result;
        Assert.That(constrained.Positions, Is.EqualTo(first.Positions), "a single thread must give the same positions");
    }

    private sealed class SingleThreadScheduler : TaskScheduler
    {
        protected override IEnumerable<Task>? GetScheduledTasks() => null;
        protected override void QueueTask(Task task) => TryExecuteTask(task);
        protected override bool TryExecuteTaskInline(Task task, bool taskWasPreviouslyQueued) => TryExecuteTask(task);
    }

    [Test]
    public void A_wider_transition_zone_helps_the_Laplacian_a_lot_and_the_optimization_makes_the_width_matter_much_less()
    {
        double[] plain = new double[3], optimized = new double[3];
        int[] cells = new int[3];
        for (int depth = 0; depth < 3; depth++)
        {
            var mesh = Middle(depth);
            plain[depth] = Smoothing.Smooth(mesh, new SmoothingOptions(40, 0.5, 0.5, true)).After.MinScaled;
            optimized[depth] = Smoothing.Smooth(mesh, new SmoothingOptions(20, 0.5, 0.5, true, OptimizationPasses: 10)).After.MinScaled;
            cells[depth] = mesh.Cells.Count;
        }
        TestContext.Out.WriteLine($"DEPTHS worst after the Laplacian {plain[0]:0.000}/{plain[1]:0.000}/{plain[2]:0.000}, after the optimization {optimized[0]:0.000}/{optimized[1]:0.000}/{optimized[2]:0.000}, cells {cells[0]}/{cells[1]}/{cells[2]}");
        Assert.That(cells[0], Is.LessThan(cells[1]));
        Assert.That(cells[1], Is.LessThan(cells[2]));
        Assert.That(plain[2], Is.GreaterThan(plain[0] * 2), "the book's wide zone gives the Laplacian much better cells to end with");
        Assert.That(optimized.Min(), Is.GreaterThan(0.3), "with the optimization every width ends with decent cells");
        Assert.That(optimized[0], Is.GreaterThan(plain[2]), "the optimization on the minimal zone beats the Laplacian on the wide one");
    }

    [Test]
    public void Going_on_from_the_result_never_makes_it_worse_and_the_baseline_stays_the_lattice()
    {
        var mesh = Middle();
        var first = Smoothing.Smooth(mesh, new SmoothingOptions(10, 0.5, 0.5, true, OptimizationPasses: 3));
        var more = Smoothing.Smooth(mesh, new SmoothingOptions(0, 0.5, 0.5, true, OptimizationPasses: 10), start: first.Positions);

        Assert.That(more.Before.MinScaled, Is.EqualTo(first.Before.MinScaled), "'before' is always the mesh as it came out of the refinement");
        Assert.That(more.After.MinScaled, Is.GreaterThanOrEqualTo(first.After.MinScaled - 1e-9));
        Assert.That(more.After.MeanScaled, Is.GreaterThanOrEqualTo(first.After.MeanScaled - 1e-9));
        Assert.Throws<ArgumentException>(() => Smoothing.Smooth(mesh, new SmoothingOptions(1), start: new double[5]));
    }

    [Test]
    public void The_passes_of_the_optimization_are_reported_after_those_of_the_Laplacian_and_it_can_be_stopped()
    {
        var mesh = Middle();
        var seen = new List<int>();
        Smoothing.Smooth(mesh, new SmoothingOptions(3, 0.5, 0.5, true, OptimizationPasses: 4), (pass, _) => seen.Add(pass));
        Assert.That(seen.Take(3), Is.EqualTo(new[] { 1, 2, 3 }));
        Assert.That(seen.Skip(3), Is.Not.Empty.And.Ordered);
        Assert.That(seen[3], Is.EqualTo(4), "the first pass of the optimization comes after the three of the Laplacian");

        using var stop = new CancellationTokenSource();
        int last = 0;
        Smoothing.Smooth(mesh, new SmoothingOptions(0, 0.5, 0.5, true, OptimizationPasses: 50), (pass, _) => { last = pass; if (pass == 2) stop.Cancel(); }, stop.Token);
        Assert.That(last, Is.EqualTo(2));
    }

    [Test]
    public void A_negative_number_of_passes_is_refused()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Smoothing.Smooth(HexMesh.Grid(2, 2, 2), new SmoothingOptions(OptimizationPasses: -1)));
    }
}
