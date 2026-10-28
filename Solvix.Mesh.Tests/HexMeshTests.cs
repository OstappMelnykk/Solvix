using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

public class HexMeshTests
{
    private static bool Near(Vec3 a, Vec3 b, double tol = 1e-9) => (a - b).Length < tol;

    [Test]
    public void First_cube_is_the_unit_cube_with_20_nodes()
    {
        var mesh = new HexMesh();
        var hex = mesh.AddFirst();

        Assert.That(mesh.Nodes.Count, Is.EqualTo(20));
        Assert.That(hex.Map(new Vec3(-1, -1, -1)), Is.EqualTo(Vec3.Zero));
        Assert.That(Near(hex.Map(new Vec3(1, 1, 1)), new Vec3(1, 1, 1)), Is.True);
        Assert.That(Near(hex.Map(Vec3.Zero), new Vec3(0.5, 0.5, 0.5)), Is.True);
        Assert.That(hex.Determinant(Vec3.Zero), Is.EqualTo(0.125).Within(1e-12));
    }

    [Test]
    public void Adding_a_cube_on_a_face_shares_the_eight_face_nodes_and_links_them()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);

        Assert.That(mesh.Nodes.Count, Is.EqualTo(32));
        Assert.That(mesh.Neighbor(a.Id, HexFace.XPlus), Is.EqualTo(b.Id));
        Assert.That(mesh.Neighbor(b.Id, HexFace.XMinus), Is.EqualTo(a.Id));
        foreach (int s in HexFace.XPlus.Slots())
            Assert.That(a.NodeIds[s], Is.EqualTo(b.NodeIds[HexFace.XPlus.PartnerSlot(s)]));
        Assert.That(Near(b.Map(new Vec3(1, 1, 1)), new Vec3(2, 1, 1)), Is.True);
        Assert.That(b.Cell, Is.EqualTo((1, 0, 0)));
    }

    [Test]
    public void The_far_face_of_an_added_cube_is_flat_and_lies_beyond_a_bumpy_shared_face()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        // Push the shared face's corners out and in (and all its midpoints out), so it is
        // bumpy but its normal stays along X.
        var slots = HexFace.XPlus.Slots().ToArray();
        for (int i = 0; i < slots.Length; i++)
        {
            var node = mesh.Node(a.NodeIds[slots[i]]);
            double dx = Hex20Reference.IsCorner(slots[i]) ? 0.3 * Math.Sin(i + 1) : 0.2;
            mesh.DragNode(node.Id, node.Position + new Vec3(dx, 0, 0));
        }
        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);

        var far = HexFace.XPlus.Slots().Select(s => mesh.Node(b.NodeIds[s]).Position).ToArray();
        var shared = slots.Select(s => mesh.Node(a.NodeIds[s]).Position).ToArray();
        var corners = HexFace.XPlus.Slots().Where(Hex20Reference.IsCorner).Select(sl => mesh.Node(b.NodeIds[sl]).Position).ToArray();
        var e1 = corners[1] - corners[0];
        var e2 = corners[2] - corners[0];
        var n = new Vec3(e1.Y * e2.Z - e1.Z * e2.Y, e1.Z * e2.X - e1.X * e2.Z, e1.X * e2.Y - e1.Y * e2.X);
        n *= 1.0 / n.Length;
        double Along(Vec3 v) => v.X * n.X + v.Y * n.Y + v.Z * n.Z;
        if (Along(far[0] - shared[0]) < 0) n *= -1;
        Assert.That(far.Max(v => Along(v)) - far.Min(v => Along(v)), Is.EqualTo(0).Within(1e-9), "far face is one plane");
        Assert.That(far.Min(v => Along(v)), Is.GreaterThan(shared.Max(v => Along(v))), "far face is beyond the shared face");
        Assert.That(b.Determinant(Vec3.Zero), Is.GreaterThan(0));
    }

    [Test]
    public void Adding_onto_an_occupied_cell_is_refused()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);
        var c = mesh.AddOnFace(b.Id, HexFace.YPlus);
        var d = mesh.AddOnFace(a.Id, HexFace.YPlus);

        Assert.Throws<InvalidOperationException>(() => mesh.AddOnFace(d.Id, HexFace.XPlus));
        Assert.That(c.Cell, Is.EqualTo((1, 1, 0)));
    }

    // 2x2 square of cubes in one plane: A(0,0) B(1,0) C(1,1) D(0,1).
    // D is attached to A only, so it touches C visually without being its neighbour.
    private static (HexMesh Mesh, Hex20 A, Hex20 B, Hex20 C, Hex20 D) Square()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);
        var c = mesh.AddOnFace(b.Id, HexFace.YPlus);
        var d = mesh.AddOnFace(a.Id, HexFace.YPlus);
        return (mesh, a, b, c, d);
    }

    [Test]
    public void Touching_cubes_are_not_neighbours_until_linked()
    {
        var (mesh, _, _, c, d) = Square();

        Assert.That(mesh.Neighbor(d.Id, HexFace.XPlus), Is.Null);
        Assert.That(mesh.LinkCandidates(), Has.Exactly(1).Matches<(int HexA, HexFace Face, int HexB)>(x => x.HexA == d.Id && x.HexB == c.Id));

        int dSlot = HexFace.XPlus.Slots().First(s => !Hex20Reference.IsCorner(s));
        Assert.That(d.NodeIds[dSlot], Is.Not.EqualTo(c.NodeIds[HexFace.XPlus.PartnerSlot(dSlot)]));
    }

    [Test]
    public void Linking_merges_nodes_and_removes_the_candidate()
    {
        var (mesh, _, _, c, d) = Square();
        int before = mesh.Nodes.Count;

        Assert.That(mesh.TryLink(d.Id, HexFace.XPlus, out var error), Is.True, error);

        Assert.That(mesh.Nodes.Count, Is.LessThan(before));
        foreach (int s in HexFace.XPlus.Slots())
            Assert.That(d.NodeIds[s], Is.EqualTo(c.NodeIds[HexFace.XPlus.PartnerSlot(s)]));
        Assert.That(mesh.Neighbor(d.Id, HexFace.XPlus), Is.EqualTo(c.Id));
        Assert.That(mesh.LinkCandidates(), Is.Empty);
    }

    [Test]
    public void Linking_is_refused_when_the_faces_have_been_pulled_apart()
    {
        var (mesh, _, _, _, d) = Square();
        // a corner that only D owns on the C-D face
        var onlyD = HexFace.XPlus.Slots().Where(Hex20Reference.IsCorner)
            .Select(s => d.NodeIds[s]).First(n => mesh.OwnersOf(n).All(o => o.Hex == d.Id));
        mesh.DragNode(onlyD, mesh.Node(onlyD).Position + new Vec3(0.2, 0, 0));

        Assert.That(mesh.TryLink(d.Id, HexFace.XPlus, out var error), Is.False);
        Assert.That(error, Is.Not.Null);
        Assert.That(mesh.Neighbor(d.Id, HexFace.XPlus), Is.Null);
    }

    [Test]
    public void Unlinking_splits_the_nodes_again_and_keeps_positions()
    {
        var (mesh, _, _, c, d) = Square();
        mesh.TryLink(d.Id, HexFace.XPlus, out _);
        var positions = d.NodeIds.Select(n => mesh.Node(n).Position).ToArray();

        mesh.Unlink(d.Id, HexFace.XPlus);

        Assert.That(mesh.Neighbor(d.Id, HexFace.XPlus), Is.Null);
        Assert.That(mesh.LinkCandidates(), Has.Count.EqualTo(1));
        for (int s = 0; s < 20; s++)
            Assert.That(Near(mesh.Node(d.NodeIds[s]).Position, positions[s]), Is.True);
        int dSlot = HexFace.XPlus.Slots().First(s => !Hex20Reference.IsCorner(s));
        Assert.That(d.NodeIds[dSlot], Is.Not.EqualTo(c.NodeIds[HexFace.XPlus.PartnerSlot(dSlot)]));
    }

    [Test]
    public void Unlinking_keeps_nodes_that_are_still_connected_through_other_links()
    {
        var (mesh, a, b, c, d) = Square();
        mesh.TryLink(d.Id, HexFace.XPlus, out _);
        // The vertical edge shared by all four cubes is joined through several links.
        int cornerSlotD = 1;   // D corner (+,-,-): the central vertical edge bottom, shared by all four cubes
        int shared = d.NodeIds[cornerSlotD];
        mesh.Unlink(d.Id, HexFace.XPlus);
        Assert.That(d.NodeIds[cornerSlotD], Is.EqualTo(shared));
        Assert.That(a.NodeIds[2], Is.EqualTo(shared));
        Assert.That(b.NodeIds[3], Is.EqualTo(shared));
        Assert.That(c.NodeIds[0], Is.EqualTo(shared));
    }

    [Test]
    public void Dragging_a_shared_node_deforms_every_owner()
    {
        var (mesh, a, b, _, _) = Square();
        int shared = a.NodeIds[1];                      // corner (+,-,-) of A, also B's slot 0
        Assert.That(b.NodeIds[0], Is.EqualTo(shared));
        var target = mesh.Node(shared).Position + new Vec3(0, -0.3, 0.1);

        mesh.DragNode(shared, target);

        Assert.That(Near(a.Map(new Vec3(1, -1, -1)), target), Is.True);
        Assert.That(Near(b.Map(new Vec3(-1, -1, -1)), target), Is.True);
    }

    [Test]
    public void Dragging_a_corner_carries_its_edge_midpoints_by_half()
    {
        var mesh = new HexMesh();
        var hex = mesh.AddFirst();
        var cornerBefore = mesh.Node(hex.NodeIds[0]).Position;
        var midBefore = mesh.Node(hex.NodeIds[8]).Position;   // edge 0-1
        var farMidBefore = mesh.Node(hex.NodeIds[10]).Position; // edge 2-3, not incident
        var delta = new Vec3(-0.2, 0.1, 0.3);

        mesh.DragNode(hex.NodeIds[0], cornerBefore + delta);

        Assert.That(Near(mesh.Node(hex.NodeIds[8]).Position, midBefore + delta * 0.5), Is.True);
        Assert.That(Near(mesh.Node(hex.NodeIds[10]).Position, farMidBefore), Is.True);
        // an undeformed edge stays straight: midpoint is the average of its corners
        var straight = (mesh.Node(hex.NodeIds[0]).Position + mesh.Node(hex.NodeIds[1]).Position) * 0.5;
        Assert.That(Near(mesh.Node(hex.NodeIds[8]).Position, straight), Is.True);
    }

    [Test]
    public void Ideal_and_real_worlds_map_both_ways_on_a_deformed_mesh()
    {
        var (mesh, a, _, c, _) = Square();
        mesh.DragNode(a.NodeIds[6], mesh.Node(a.NodeIds[6]).Position + new Vec3(0.15, 0.1, 0.2));
        mesh.DragNode(c.NodeIds[7], mesh.Node(c.NodeIds[7]).Position + new Vec3(-0.1, 0.25, 0.05));

        foreach (var ideal in new[] { new Vec3(0.3, 0.6, 0.4), new Vec3(1.7, 1.2, 0.8), new Vec3(1.2, 0.35, 0.5) })
        {
            Assert.That(mesh.TryMapIdealToReal(ideal, out var real), Is.True);
            Assert.That(mesh.TryMapRealToIdeal(real, out var back), Is.True);
            Assert.That(Near(back, ideal, 1e-7), Is.True, $"{ideal} -> {real} -> {back}");
        }
        Assert.That(mesh.TryMapIdealToReal(new Vec3(5, 5, 5), out _), Is.False);
    }

    [Test]
    public void A_cube_added_on_a_deformed_host_continues_the_map_and_stays_attached()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        mesh.DragNode(a.NodeIds[6], mesh.Node(a.NodeIds[6]).Position + new Vec3(0.3, 0.2, 0));

        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);

        foreach (int s in HexFace.XPlus.Slots())
            Assert.That(b.NodeIds[HexFace.XPlus.PartnerSlot(s)], Is.EqualTo(a.NodeIds[s]));
        Assert.That(b.Determinant(Vec3.Zero), Is.GreaterThan(0));
        Assert.That(mesh.Nodes.All(n => !double.IsNaN(n.Position.X + n.Position.Y + n.Position.Z)), Is.True);
    }

    [Test]
    public void Nodes_carry_integer_ideal_coordinates()
    {
        var (mesh, _, b, _, _) = Square();

        Assert.That(mesh.Node(b.NodeIds[6]).Ideal, Is.EqualTo((4, 2, 2)));  // B cell (1,0,0), corner (+,+,+)
        Assert.That(mesh.Node(b.NodeIds[8]).Ideal, Is.EqualTo((3, 0, 0)));  // midpoint of edge 0-1
    }

    [Test]
    public void Solver_snapshot_has_20_nodes_per_element_and_shares_nodes_once()
    {
        var (mesh, a, b, _, _) = Square();

        var fem = mesh.ToFemMesh();

        Assert.That(fem.ElementCount, Is.EqualTo(4));
        Assert.That(fem.NodeCount, Is.EqualTo(mesh.Nodes.Count));
        Assert.That(fem.Connectivity.GetLength(1), Is.EqualTo(20));
        int ea = Array.IndexOf(fem.ElementIds, a.Id);
        int eb = Array.IndexOf(fem.ElementIds, b.Id);
        foreach (int s in HexFace.XPlus.Slots())
            Assert.That(fem.Connectivity[ea, s], Is.EqualTo(fem.Connectivity[eb, HexFace.XPlus.PartnerSlot(s)]));
        for (int e = 0; e < 4; e++)
            for (int s = 0; s < 20; s++)
                Assert.That(fem.Connectivity[e, s], Is.InRange(0, fem.NodeCount - 1));
        int nA = fem.Connectivity[ea, 0];
        var p = mesh.Node(fem.NodeIds[nA]).Position;
        Assert.That(fem.Positions[nA, 0], Is.EqualTo(p.X));
    }
}

public class DeterminantTableTests
{
    [Test]
    public void The_tabulated_minimum_determinant_equals_the_direct_one_for_deformed_cubes()
    {
        var random = new Random(11);
        for (int trial = 0; trial < 200; trial++)
        {
            var positions = Enumerable.Range(0, Hex20Reference.NodeCount).Select(s => new Vec3(
                (Hex20Reference.LocalCoords[s, 0] + 1) / 2.0 + (random.NextDouble() - 0.5) * 0.4,
                (Hex20Reference.LocalCoords[s, 1] + 1) / 2.0 + (random.NextDouble() - 0.5) * 0.4,
                (Hex20Reference.LocalCoords[s, 2] + 1) / 2.0 + (random.NextDouble() - 0.5) * 0.4)).ToList();

            var (min, max) = Hex20Geometry.DeterminantRange(positions);

            Assert.That(min, Is.EqualTo(Hex20Geometry.MinDeterminantDirect(positions)).Within(1e-12));
            Assert.That(max, Is.GreaterThanOrEqualTo(min));
            Assert.That(Hex20Geometry.MinDeterminant(positions), Is.EqualTo(min));
        }
    }
}
