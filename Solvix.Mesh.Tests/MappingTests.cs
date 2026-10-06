using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

public class MappingTests
{
    private static bool Near(Vec3 a, Vec3 b, double tol = 1e-7) => (a - b).Length < tol;

    // A fully conforming 2x2x2 block: every touching pair is linked.
    private static HexMesh Block()
    {
        var mesh = new HexMesh();
        var first = mesh.AddFirst();
        var cells = new Queue<int>();
        cells.Enqueue(first.Id);
        // grow to 2x2x2 by attaching along +X, then +Y, then +Z
        var all = new List<Hex20> { first };
        foreach (var face in new[] { HexFace.XPlus, HexFace.YPlus, HexFace.ZPlus })
            foreach (var h in all.ToList())
                all.Add(mesh.AddOnFace(h.Id, face));
        foreach (var (a, face, _) in mesh.LinkCandidates().ToList())
            Assert.That(mesh.TryLink(a, face, out var err), Is.True, err);
        Assert.That(mesh.LinkCandidates(), Is.Empty);
        return mesh;
    }

    private static void Wobble(HexMesh mesh, int seed, double amplitude)
    {
        var rng = new Random(seed);
        foreach (var node in mesh.Nodes.OrderBy(n => n.Id).ToList())
        {
            var d = new Vec3(rng.NextDouble() - 0.5, rng.NextDouble() - 0.5, rng.NextDouble() - 0.5) * (2 * amplitude);
            Assert.That(mesh.TryDragNode(node.Id, node.Position + d, out _), Is.True);
        }
    }

    [Test]
    public void Block_is_conforming_with_the_expected_node_count()
    {
        var mesh = Block();

        Assert.That(mesh.Hexes.Count, Is.EqualTo(8));
        // 2x2x2 H20 block: 27 corners + 54 edge midpoints (3 axes x 18)
        Assert.That(mesh.Nodes.Count, Is.EqualTo(27 + 54));
    }

    [Test]
    public void Ideal_to_real_to_ideal_round_trips_on_a_randomly_deformed_block()
    {
        var mesh = Block();
        Wobble(mesh, seed: 7, amplitude: 0.06);
        Assert.That(mesh.InvalidHexes(), Is.Empty);

        var rng = new Random(11);
        for (int i = 0; i < 300; i++)
        {
            var ideal = new Vec3(rng.NextDouble() * 2, rng.NextDouble() * 2, rng.NextDouble() * 2);
            Assert.That(mesh.TryMapIdealToReal(ideal, out var real), Is.True);
            Assert.That(mesh.TryMapRealToIdeal(real, out var back), Is.True, $"{ideal}");
            Assert.That(Near(back, ideal), Is.True, $"{ideal} -> {real} -> {back}");
        }
    }

    [Test]
    public void Mapping_is_continuous_across_every_linked_face()
    {
        var mesh = Block();
        Wobble(mesh, seed: 3, amplitude: 0.08);
        var rng = new Random(5);

        foreach (var hex in mesh.Hexes)
        {
            foreach (var face in HexFaces.All)
            {
                if (mesh.Neighbor(hex.Id, face) is not int other) continue;
                int axis = face.Axis();
                for (int i = 0; i < 20; i++)
                {
                    var xi = new Vec3(rng.NextDouble() * 2 - 1, rng.NextDouble() * 2 - 1, rng.NextDouble() * 2 - 1).With(axis, face.Sign());
                    var across = xi.With(axis, -face.Sign());
                    Assert.That(Near(hex.Map(xi), mesh.Hex(other).Map(across), 1e-12), Is.True);
                }
            }
        }
    }

    [Test]
    public void A_point_on_a_shared_face_maps_back_to_the_same_ideal_point()
    {
        var mesh = Block();
        Wobble(mesh, seed: 21, amplitude: 0.05);
        var ideal = new Vec3(1.0, 0.37, 0.61); // the x=1 plane between two cells

        Assert.That(mesh.TryMapIdealToReal(ideal, out var real), Is.True);
        Assert.That(mesh.TryMapRealToIdeal(real, out var back), Is.True);
        Assert.That(Near(back, ideal), Is.True, $"{back}");
    }

    [Test]
    public void The_outer_boundary_of_the_body_maps_in_both_directions()
    {
        var mesh = Block();

        Assert.That(mesh.TryMapIdealToReal(new Vec3(2, 2, 2), out var corner), Is.True);
        Assert.That(Near(corner, new Vec3(2, 2, 2)), Is.True);
        Assert.That(mesh.TryMapRealToIdeal(new Vec3(2, 1, 0.5), out var back), Is.True);
        Assert.That(Near(back, new Vec3(2, 1, 0.5)), Is.True);
        Assert.That(mesh.TryMapIdealToReal(new Vec3(2.01, 0.5, 0.5), out _), Is.False);
        Assert.That(mesh.TryMapRealToIdeal(new Vec3(2.5, 0.5, 0.5), out _), Is.False);
    }

    [Test]
    public void An_undeformed_mesh_maps_ideal_to_itself()
    {
        var mesh = Block();

        Assert.That(mesh.TryMapIdealToReal(new Vec3(1.3, 0.2, 1.9), out var real), Is.True);
        Assert.That(Near(real, new Vec3(1.3, 0.2, 1.9)), Is.True);
    }

    [Test]
    public void A_move_that_would_fold_a_hex_is_refused_and_leaves_the_mesh_untouched()
    {
        var mesh = new HexMesh();
        var hex = mesh.AddFirst();
        int corner = hex.NodeIds[0];
        var before = mesh.Nodes.ToDictionary(n => n.Id, n => n.Position);

        // pull a corner through the opposite corner
        bool ok = mesh.TryDragNode(corner, new Vec3(1.5, 1.5, 1.5), out var bad);

        Assert.That(ok, Is.False);
        Assert.That(bad, Does.Contain(hex.Id));
        foreach (var n in mesh.Nodes) Assert.That(n.Position, Is.EqualTo(before[n.Id]));
        Assert.That(hex.IsValid(), Is.True);
    }

    [Test]
    public void Min_determinant_is_positive_for_the_unit_cube_and_negative_for_a_folded_one()
    {
        var mesh = new HexMesh();
        var hex = mesh.AddFirst();
        Assert.That(hex.MinDeterminant(), Is.EqualTo(0.125).Within(1e-12));

        mesh.DragNode(hex.NodeIds[0], new Vec3(1.5, 1.5, 1.5));
        Assert.That(hex.MinDeterminant(), Is.LessThan(0));
        Assert.That(mesh.InvalidHexes(), Does.Contain(hex.Id));
    }

    [Test]
    public void Overlapping_unlinked_hexes_resolve_to_the_deepest_one_deterministically()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);
        mesh.Unlink(a.Id, HexFace.XPlus);
        // push b's near face into a so the two overlap in real space
        foreach (int s in HexFace.XMinus.Slots())
            mesh.SetNodePosition(b.NodeIds[s], mesh.Node(b.NodeIds[s]).Position - new Vec3(0.4, 0, 0));

        Assert.That(mesh.TryLocate(new Vec3(0.65, 0.5, 0.5), out int inA, out _), Is.True);
        Assert.That(inA, Is.EqualTo(a.Id));      // a is deeper here; b only just starts
        Assert.That(mesh.TryLocate(new Vec3(1.2, 0.5, 0.5), out int inB, out _), Is.True);
        Assert.That(inB, Is.EqualTo(b.Id));
    }

    [Test]
    public void A_strongly_curved_hex_still_inverts()
    {
        var mesh = new HexMesh();
        var hex = mesh.AddFirst();
        // bend the top face edge midpoints upward
        foreach (int slot in new[] { 12, 13, 14, 15 })
            mesh.SetNodePosition(hex.NodeIds[slot], mesh.Node(hex.NodeIds[slot]).Position + new Vec3(0, 0, 0.25));
        Assert.That(hex.IsValid(), Is.True);

        foreach (var xi in new[] { new Vec3(0.8, -0.7, 0.9), new Vec3(-0.9, 0.9, 0.95), new Vec3(0.1, 0.2, -0.8) })
        {
            var real = hex.Map(xi);
            Assert.That(mesh.TryLocate(real, out int id, out var found), Is.True);
            Assert.That(Near(found, xi), Is.True, $"{xi} -> {found}");
            Assert.That(id, Is.EqualTo(hex.Id));
        }
    }
}
