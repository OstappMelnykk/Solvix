using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

public class ShapeTests
{
    private static bool Near(Vec3 a, Vec3 b, double tol = 1e-9) => (a - b).Length < tol;

    private static Vec3 Local(int slot) => new(Hex20Reference.LocalCoords[slot, 0], Hex20Reference.LocalCoords[slot, 1], Hex20Reference.LocalCoords[slot, 2]);

    private static Vec3 PositionOf(HexMesh mesh, Hex20 hex, int slot) => mesh.Node(hex.NodeIds[slot]).Position;

    private static IEnumerable<Vec3> Positions(HexMesh mesh, Hex20 hex) => Enumerable.Range(0, 20).Select(s => PositionOf(mesh, hex, s));

    // ---- the shape itself -------------------------------------------------------------

    [Test]
    public void A_shape_needs_exactly_twenty_finite_positions()
    {
        Assert.Throws<ArgumentException>(() => new HexShape(Enumerable.Repeat(Vec3.Zero, 19)));
        Assert.Throws<ArgumentException>(() => new HexShape(Enumerable.Repeat(Vec3.Zero, 21)));
        var withNaN = HexShape.Unit.Positions.ToList();
        withNaN[5] = new Vec3(double.NaN, 0, 0);
        Assert.Throws<ArgumentException>(() => new HexShape(withNaN));
        var withInfinity = HexShape.Unit.Positions.ToList();
        withInfinity[7] = new Vec3(0, double.PositiveInfinity, 0);
        Assert.Throws<ArgumentException>(() => new HexShape(withInfinity));
    }

    [Test]
    public void Unit_and_box_have_the_natural_positions_and_the_right_volume_factor()
    {
        var unit = HexShape.Unit;
        for (int s = 0; s < 20; s++)
            Assert.That(Near(unit.Positions[s], (Local(s) + new Vec3(1, 1, 1)) * 0.5), Is.True, $"slot {s}");
        Assert.That(unit.MinDeterminant(), Is.EqualTo(0.125).Within(1e-12));

        var box = HexShape.Box(2, 3, 4);
        Assert.That(box.Positions[6], Is.EqualTo(new Vec3(2, 3, 4)));
        Assert.That(box.Positions[8], Is.EqualTo(new Vec3(1, 0, 0)));                 // midpoint of the bottom front edge
        Assert.That(box.MinDeterminant(), Is.EqualTo(2 * 3 * 4 / 8.0).Within(1e-12)); // constant Jacobian of a box
    }

    [Test]
    public void A_folded_or_flat_shape_is_not_valid()
    {
        var folded = HexShape.Unit.Positions.ToList();
        folded[0] = new Vec3(1.6, 1.6, 1.6);          // a corner dragged through the opposite one
        Assert.That(new HexShape(folded).IsValid(), Is.False);
        Assert.That(HexShape.Box(1, 1, 0).IsValid(), Is.False);
        Assert.That(HexShape.Unit.IsValid(), Is.True);
    }

    [Test]
    public void Geometry_without_a_mesh_agrees_with_a_hex_in_a_mesh()
    {
        var shape = new HexShape(HexShape.Unit.Positions.Select((p, i) => p + new Vec3(0.05 * i % 0.3, -0.04 * i % 0.2, 0.03 * i % 0.25)));
        var mesh = new HexMesh();
        var hex = mesh.AddFirst(shape);

        foreach (var xi in new[] { new Vec3(0.2, -0.3, 0.9), new Vec3(-1, 1, 0), Vec3.Zero })
        {
            Assert.That(Near(Hex20Geometry.Map(shape.Positions, xi), hex.Map(xi)), Is.True);
            Assert.That(Hex20Geometry.Determinant(Hex20Geometry.Jacobian(shape.Positions, xi)), Is.EqualTo(hex.Determinant(xi)).Within(1e-12));
        }
        Assert.That(shape.MinDeterminant(), Is.EqualTo(hex.MinDeterminant()).Within(1e-12));
    }

    // ---- the first cube -----------------------------------------------------------------

    [Test]
    public void The_first_cube_can_start_from_a_designed_shape_at_exactly_its_positions()
    {
        var shape = HexShape.Box(3, 1, 2);
        var mesh = new HexMesh();

        var hex = mesh.AddFirst(shape);

        for (int s = 0; s < 20; s++) Assert.That(PositionOf(mesh, hex, s), Is.EqualTo(shape.Positions[s]));
        Assert.That(hex.Cell, Is.EqualTo((0, 0, 0)));
        Assert.That(mesh.Node(hex.NodeIds[6]).Ideal, Is.EqualTo((2, 2, 2)));       // the ideal world is still the unit lattice cell
        Assert.That(mesh.TryMapIdealToReal(new Vec3(1, 1, 1), out var corner), Is.True);
        Assert.That(Near(corner, new Vec3(3, 1, 2)), Is.True);
    }

    [Test]
    public void Without_a_shape_the_first_cube_is_still_the_unit_cube()
    {
        var mesh = new HexMesh();
        var hex = mesh.AddFirst();

        for (int s = 0; s < 20; s++) Assert.That(Near(PositionOf(mesh, hex, s), HexShape.Unit.Positions[s]), Is.True);
    }

    // ---- attaching a designed cube ---------------------------------------------------------

    [Test]
    public void The_unit_shape_on_a_regular_host_is_the_same_cube_as_the_plain_extrusion()
    {
        foreach (var face in HexFaces.All)
        {
            var plain = new HexMesh();
            var a = plain.AddFirst();
            var extruded = plain.AddOnFace(a.Id, face);

            var shaped = new HexMesh();
            var b = shaped.AddFirst();
            var fitted = shaped.AddOnFace(b.Id, face, HexShape.Unit);

            for (int s = 0; s < 20; s++)
                Assert.That(Near(PositionOf(shaped, fitted, s), PositionOf(plain, extruded, s)), Is.True, $"{face} slot {s}");
        }
    }

    [Test]
    public void A_beam_on_a_matching_face_keeps_its_form_exactly()
    {
        var mesh = new HexMesh();
        var host = mesh.AddFirst();

        var beam = mesh.AddOnFace(host.Id, HexFace.XPlus, HexShape.Box(3, 1, 1));

        Assert.That(PositionOf(mesh, beam, 6), Is.EqualTo(new Vec3(4, 1, 1)));       // far corner: 1 + 3
        Assert.That(Near(PositionOf(mesh, beam, 9), new Vec3(4, 0.5, 0)), Is.True);   // far-face midpoint
        Assert.That(Near(PositionOf(mesh, beam, 8), new Vec3(2.5, 0, 0)), Is.True);   // halfway along its length
        foreach (int slot in HexFace.XPlus.Slots())                                   // the shared face is the host's own nodes
            Assert.That(beam.NodeIds[HexFace.XPlus.PartnerSlot(slot)], Is.EqualTo(host.NodeIds[slot]));
        Assert.That(beam.IsValid(), Is.True);
    }

    [Test]
    public void The_beam_goes_the_other_way_on_a_negative_face()
    {
        var mesh = new HexMesh();
        var host = mesh.AddFirst();

        var beam = mesh.AddOnFace(host.Id, HexFace.XMinus, HexShape.Box(3, 1, 1));

        Assert.That(PositionOf(mesh, beam, 0), Is.EqualTo(new Vec3(-3, 0, 0)));
        Assert.That(PositionOf(mesh, beam, 6), Is.EqualTo(new Vec3(0, 1, 1)));
        Assert.That(beam.IsValid(), Is.True);
    }

    [Test]
    public void A_wide_cube_on_a_small_face_is_fitted_to_it_on_the_near_side_and_keeps_its_far_face()
    {
        var mesh = new HexMesh();
        var host = mesh.AddFirst();

        // a 3 x 1 x 1 beam lying along X, attached with its bottom face on the host's 1x1 top face
        var beam = mesh.AddOnFace(host.Id, HexFace.YPlus, HexShape.Box(3, 1, 1));

        // near face = the host's own top face (fitted); far face = the beam's top, centred over it
        foreach (int slot in HexFace.YPlus.Slots())
            Assert.That(beam.NodeIds[HexFace.YPlus.PartnerSlot(slot)], Is.EqualTo(host.NodeIds[slot]));
        Assert.That(Near(PositionOf(mesh, beam, 6), new Vec3(2, 2, 1)), Is.True);      // far corner (+,+,+): x = 0.5 + 1.5
        Assert.That(Near(PositionOf(mesh, beam, 7), new Vec3(-1, 2, 1)), Is.True);     // far corner (-,+,+): x = 0.5 - 1.5
        Assert.That(PositionOf(mesh, beam, 6).Y, Is.EqualTo(2).Within(1e-12));
        Assert.That(beam.IsValid(), Is.True);
        Assert.That(mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void A_cube_designed_turned_around_the_attaching_axis_is_turned_back_onto_the_face()
    {
        // the unit cube rotated by 90 degrees about X (y and z swapped / mirrored into place): the
        // attaching face keeps its in-plane orientation by its own face frame, so the cube lands upright
        var rotated = new HexShape(HexShape.Unit.Positions.Select(p => new Vec3(p.X, 1 - p.Z, p.Y)));
        Assert.That(rotated.IsValid(), Is.True);
        var mesh = new HexMesh();
        var host = mesh.AddFirst();

        var added = mesh.AddOnFace(host.Id, HexFace.XPlus, rotated);

        Assert.That(added.IsValid(), Is.True);
        Assert.That(Near(PositionOf(mesh, added, 6), new Vec3(2, 1, 1)), Is.True);
        Assert.That(Near(PositionOf(mesh, added, 4), new Vec3(1, 0, 1)), Is.True);
        foreach (int slot in HexFace.XPlus.Slots())
            Assert.That(added.NodeIds[HexFace.XPlus.PartnerSlot(slot)], Is.EqualTo(host.NodeIds[slot]));
    }

    [Test]
    public void Fitting_onto_a_skewed_host_face_keeps_the_shared_face_and_a_rigid_far_face()
    {
        var mesh = new HexMesh();
        var host = mesh.AddFirst();
        mesh.SetNodePosition(host.NodeIds[2], new Vec3(1, 1.4, 0));                    // skew the +X face (still planar)

        var added = mesh.AddOnFace(host.Id, HexFace.XPlus, HexShape.Unit);

        foreach (int slot in HexFace.XPlus.Slots())
            Assert.That(added.NodeIds[HexFace.XPlus.PartnerSlot(slot)], Is.EqualTo(host.NodeIds[slot]));
        // the far face is the unit cube's own far face, carried rigidly: still a unit square
        var corners = new[] { 1, 2, 6, 5 }.Select(s => PositionOf(mesh, added, s)).ToArray();
        for (int i = 0; i < 4; i++)
            Assert.That((corners[i] - corners[(i + 1) % 4]).Length, Is.EqualTo(1).Within(1e-9), $"far edge {i}");
        Assert.That(added.IsValid(), Is.True);
    }

    [Test]
    public void A_degenerate_face_cannot_be_fitted_and_nothing_changes()
    {
        var mesh = new HexMesh();
        var host = mesh.AddFirst();
        var collapsed = HexShape.Unit.Positions.Select((p, i) => Hex20Reference.LocalCoords[i, 0] == -1 ? new Vec3(0, 0, 0) : p);

        Assert.Throws<InvalidOperationException>(() => mesh.AddOnFace(host.Id, HexFace.XPlus, new HexShape(collapsed)));
    }

    [Test]
    public void The_new_cube_belongs_to_the_next_lattice_cell_and_is_a_linked_neighbour()
    {
        var mesh = new HexMesh();
        var host = mesh.AddFirst();

        var added = mesh.AddOnFace(host.Id, HexFace.YPlus, HexShape.Box(2, 1, 1));

        Assert.That(added.Cell, Is.EqualTo((0, 1, 0)));
        Assert.That(mesh.Neighbor(host.Id, HexFace.YPlus), Is.EqualTo(added.Id));
        Assert.That(mesh.Neighbor(added.Id, HexFace.YMinus), Is.EqualTo(host.Id));
        Assert.That(mesh.TryMapRealToIdeal(PositionOf(mesh, added, 6) * 0.5 + PositionOf(mesh, added, 0) * 0.5, out var ideal), Is.True);
        Assert.That(ideal.Y, Is.InRange(1.0, 2.0));
    }

    [Test]
    public void A_shaped_cube_still_obeys_the_independent_control_point_property()
    {
        var mesh = new HexMesh();
        var host = mesh.AddFirst();
        var added = mesh.AddOnFace(host.Id, HexFace.XPlus, HexShape.Box(2, 1, 1));
        var before = Enumerable.Range(0, 20).Select(s => PositionOf(mesh, added, s)).ToArray();

        mesh.SetNodePosition(added.NodeIds[6], before[6] + new Vec3(0.3, 0.2, -0.1));

        for (int s = 0; s < 20; s++)
            Assert.That(PositionOf(mesh, added, s), s == 6 ? Is.Not.EqualTo(before[s]) : Is.EqualTo(before[s]));
    }

    // ---- through the editor ---------------------------------------------------------------

    [Test]
    public void The_editor_attaches_a_shaped_cube_as_one_undo_step()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var before = editor.Mesh.ToState();

        var result = editor.AddHexOnFace(0, HexFace.XPlus, HexShape.Box(3, 1, 1));

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(2));
        editor.Undo();
        Assert.That(editor.Mesh.ToState().Nodes, Is.EquivalentTo(before.Nodes));
        editor.Redo();
        Assert.That(editor.Mesh.Hex(1).NodeIds.Length, Is.EqualTo(20));
        Assert.That(PositionOf(editor.Mesh, editor.Mesh.Hex(1), 6), Is.EqualTo(new Vec3(4, 1, 1)));
    }

    [Test]
    public void The_editor_starts_from_a_designed_cube_and_refuses_to_start_twice()
    {
        var editor = new HexMeshEditor();

        Assert.That(editor.AddFirstHex(HexShape.Box(2, 2, 2)).Ok, Is.True);
        Assert.That(PositionOf(editor.Mesh, editor.Mesh.Hex(0), 6), Is.EqualTo(new Vec3(2, 2, 2)));
        Assert.That(editor.AddFirstHex(HexShape.Unit).Ok, Is.False);
    }

    [Test]
    public void A_degenerate_attach_is_reported_and_leaves_the_mesh_as_it_was()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var before = editor.Mesh.ToState();
        int version = editor.Version;
        var flat = HexShape.Unit.Positions.Select((p, i) => Hex20Reference.LocalCoords[i, 0] == -1 ? Vec3.Zero : p);

        var result = editor.AddHexOnFace(0, HexFace.XPlus, new HexShape(flat));

        Assert.That(result.Ok, Is.False);
        Assert.That(result.Error, Does.Contain("degenerate"));
        Assert.That(editor.Mesh.ToState().Nodes, Is.EquivalentTo(before.Nodes));
        Assert.That(editor.Version, Is.EqualTo(version));
    }

    [Test]
    public void A_shape_attached_to_an_unknown_hex_or_a_taken_face_is_refused()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);

        Assert.That(editor.AddHexOnFace(9, HexFace.XPlus, HexShape.Unit).Error, Does.Contain("Unknown hex"));
        Assert.That(editor.AddHexOnFace(0, HexFace.XPlus, HexShape.Unit).Ok, Is.False);
    }

    [Test]
    public void State_snapshots_of_a_mesh_with_shaped_cubes_round_trip()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex(HexShape.Box(2, 1, 1));
        editor.AddHexOnFace(0, HexFace.YPlus, HexShape.Box(1, 2, 1));
        var state = editor.Mesh.ToState();

        var rebuilt = HexMesh.FromState(state);

        Assert.That(rebuilt.ToState().Nodes, Is.EquivalentTo(state.Nodes));
        Assert.That(rebuilt.Hex(1).MinDeterminant(), Is.EqualTo(editor.Mesh.Hex(1).MinDeterminant()).Within(1e-12));
    }

    [Test]
    public void Solver_snapshot_of_shaped_cubes_has_the_designed_positions()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex(HexShape.Box(2, 1, 1));
        editor.AddHexOnFace(0, HexFace.XPlus, HexShape.Box(3, 1, 1));

        var fem = editor.Mesh.ToFemMesh();

        Assert.That(fem.ElementCount, Is.EqualTo(2));
        Assert.That(fem.NodeCount, Is.EqualTo(32));
        double maxX = Enumerable.Range(0, fem.NodeCount).Max(n => fem.Positions[n, 0]);
        Assert.That(maxX, Is.EqualTo(5).Within(1e-9));   // 2 + 3
    }
}
