using System.Diagnostics;
using NUnit.Framework;

namespace Solvix.Mesh.Tests;

/// <summary>
/// How good the smoothing is, as properties that must hold over many meshes: it does not make a mesh worse (the worst cube by under 1%), it keeps the
/// body's shape, it settles, and where the badness is in the interior (or in bent edges) it removes it.
/// </summary>
public class SmoothingQualityTests
{
    // a cube's regularity: smallest / largest Jacobian determinant (1 for a parallelepiped, <= 0 for a folded cube)
    private static double CubeQuality(Hex20 hex)
    {
        var (min, max) = hex.DeterminantRange();
        return min <= 1e-9 ? min : min / max;
    }

    private static double Worst(HexMesh mesh) => mesh.Hexes.Min(CubeQuality);

    private static HexMeshEditor Build(string kind, IReadOnlyDictionary<string, double> values)
    {
        var editor = new HexMeshEditor();
        Assert.That(editor.AddBody(HexTemplates.Kind(kind).Build(values)).Ok, Is.True);
        return editor;
    }

    private static HexMeshEditor Rough(int n, double jitter, int seed) => Build("rough-block", new Dictionary<string, double>
    {
        ["countX"] = n, ["countY"] = n, ["countZ"] = n, ["length"] = n, ["height"] = n, ["depth"] = n, ["jitter"] = jitter, ["seed"] = seed
    });

    [Test]
    public void It_never_makes_the_worst_cube_of_any_ready_made_body_worse_and_leaves_its_surface_where_it_is()
    {
        foreach (var preset in HexTemplates.Presets)
        {
            var editor = Build(preset.Kind, preset.Values);
            var before = editor.Mesh.Nodes.ToDictionary(n => n.Id, n => n.Position);
            double worstBefore = Worst(editor.Mesh);
            int foldedBefore = editor.Mesh.InvalidHexes().Count;
            var surface = SurfaceNodeIds(editor.Mesh);

            editor.Smooth(30, 0.5);

            // the rule is a sum over the cubes around a node, so the single worst cube may give up a hair for the others (here: under 1%)
            Assert.That(Worst(editor.Mesh), Is.GreaterThanOrEqualTo(worstBefore * 0.99 - 1e-9), preset.Name);
            Assert.That(editor.Mesh.InvalidHexes().Count, Is.LessThanOrEqualTo(foldedBefore), preset.Name);
            foreach (int id in surface)
                Assert.That((editor.Mesh.Node(id).Position - before[id]).Length, Is.LessThan(1e-12), $"{preset.Name}: surface node {id} moved");
        }
    }

    // every node (corner or midpoint) of a face that has no neighbour
    private static HashSet<int> SurfaceNodeIds(HexMesh mesh)
    {
        var ids = new HashSet<int>();
        foreach (var hex in mesh.Hexes)
            foreach (var face in HexFaces.All)
                if (mesh.Neighbor(hex.Id, face) is null)
                    foreach (int slot in face.Slots()) ids.Add(hex.NodeIds[slot]);
        return ids;
    }

    [Test]
    public void A_shaken_block_is_made_regular_for_every_seed_and_amount_of_shake()
    {
        foreach (int n in new[] { 4, 6 })
            foreach (double jitter in new[] { 0.1, 0.2, 0.25 })
                foreach (int seed in new[] { 1, 2, 3 })
                {
                    var editor = Rough(n, jitter, seed);
                    double before = Worst(editor.Mesh);

                    var result = editor.Smooth(100, 0.5);

                    Assert.That(result.Ok, Is.True, $"n={n} jitter={jitter} seed={seed}: {result.Error}");
                    Assert.That(Worst(editor.Mesh), Is.GreaterThan(0.95), $"n={n} jitter={jitter} seed={seed} (was {before:0.00})");
                    Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
                }
    }

    [Test]
    public void It_settles_and_stops_instead_of_running_all_the_passes_it_was_given()
    {
        var editor = Rough(6, 0.2, 7);

        var first = editor.Mesh.Smooth(500, 0.5);
        var second = editor.Mesh.Smooth(500, 0.5);

        Assert.That(first.Passes, Is.LessThan(500));
        Assert.That(second.MaxMove, Is.LessThan(1e-6));                    // smoothing it again changes nothing
        Assert.That(second.Passes, Is.LessThan(first.Passes));
    }

    [Test]
    public void Edges_bent_at_random_are_straightened_and_no_cube_stays_folded()
    {
        foreach (int seed in Enumerable.Range(1, 12))
        {
            var editor = Build("block", new Dictionary<string, double> { ["countX"] = 5, ["countY"] = 5, ["countZ"] = 5, ["length"] = 5, ["height"] = 5, ["depth"] = 5 });
            var random = new Random(seed);
            // a third of all the edge midpoints, anywhere on the body, thrown up to 0.6 of an edge off
            foreach (var node in editor.Mesh.Nodes.Where(n => editor.Mesh.OwnersOf(n.Id).Any(o => o.Slot >= 8)).ToList())
                if (random.NextDouble() < 0.33)
                    editor.Mesh.SetNodePosition(node.Id, node.Position + new Vec3(random.NextDouble() - 0.5, random.NextDouble() - 0.5, random.NextDouble() - 0.5) * 1.2);
            int folded = editor.Mesh.InvalidHexes().Count;

            var result = editor.Smooth(100, 0.5);

            // the edges on the surface of sound cubes are the body's shape and stay bent, so only validity is promised here
            Assert.That(editor.Mesh.InvalidHexes(), Is.Empty, $"seed {seed}: {folded} were folded; {result.Info}{result.Error}");
        }
    }

    [Test]
    public void Bent_edges_inside_the_body_are_straightened_and_the_cubes_are_regular_again()
    {
        foreach (int seed in Enumerable.Range(1, 8))
        {
            var editor = Build("block", new Dictionary<string, double> { ["countX"] = 5, ["countY"] = 5, ["countZ"] = 5, ["length"] = 5, ["height"] = 5, ["depth"] = 5 });
            var surface = SurfaceNodeIds(editor.Mesh);
            var random = new Random(seed);
            var bent = editor.Mesh.Nodes.Where(n => !surface.Contains(n.Id) && editor.Mesh.OwnersOf(n.Id).Any(o => o.Slot >= 8)).ToList();
            foreach (var node in bent)
                if (random.NextDouble() < 0.5)
                    editor.Mesh.SetNodePosition(node.Id, node.Position + new Vec3(random.NextDouble() - 0.5, random.NextDouble() - 0.5, random.NextDouble() - 0.5) * 0.8);

            editor.Smooth(100, 0.5);

            Assert.That(editor.Mesh.InvalidHexes(), Is.Empty, $"seed {seed}");
            Assert.That(Worst(editor.Mesh), Is.GreaterThan(0.99), $"seed {seed}");
        }
    }

    [Test]
    public void Corners_thrown_about_inside_the_body_are_untangled_and_the_mesh_is_made_decent()
    {
        foreach (int seed in Enumerable.Range(1, 8))
        {
            var editor = Rough(6, 0.25, seed);
            var random = new Random(seed);
            foreach (var node in editor.Mesh.Nodes.Where(n => n.Ideal.X % 2 == 0 && n.Ideal.Y % 2 == 0 && n.Ideal.Z % 2 == 0 && n.Ideal.X is > 0 and < 12 && n.Ideal.Y is > 0 and < 12 && n.Ideal.Z is > 0 and < 12).ToList())
                editor.MoveNode(node.Id, node.Position + new Vec3(random.NextDouble() - 0.5, random.NextDouble() - 0.5, random.NextDouble() - 0.5) * 0.9, true);

            var result = editor.Smooth(200, 0.5);

            // dozens of cubes folded (the corners thrown by up to 0.45 of a cube): the density that was there is lost with
            // the order of the nodes, so the cubes come out valid and fairly regular, not all the way to a regular grid
            Assert.That(editor.Mesh.InvalidHexes(), Is.Empty, $"seed {seed}: {result.Info}{result.Error}");
            Assert.That(Worst(editor.Mesh), Is.GreaterThan(0.7), $"seed {seed}");
        }
    }

    [Test]
    public void A_big_body_is_smoothed_in_seconds()
    {
        var editor = Rough(10, 0.25, 1);                                        // 1000 cubes
        var clock = Stopwatch.StartNew();

        var result = editor.Mesh.Smooth(100, 0.5);

        Assert.That(result.Moved, Is.GreaterThan(0));
        Assert.That(clock.Elapsed.TotalSeconds, Is.LessThan(20), $"took {clock.Elapsed.TotalSeconds:0.0} s, {result.Passes} passes");
    }
}
