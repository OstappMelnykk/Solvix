using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

public class EditorTests
{
    private static HexMeshEditor Square(out int a, out int b, out int c, out int d)
    {
        var editor = new HexMeshEditor();
        Assert.That(editor.AddFirstHex().Ok, Is.True);
        a = 0;
        Assert.That(editor.AddHexOnFace(a, HexFace.XPlus).Ok, Is.True); b = 1;
        Assert.That(editor.AddHexOnFace(b, HexFace.YPlus).Ok, Is.True); c = 2;
        Assert.That(editor.AddHexOnFace(a, HexFace.YPlus).Ok, Is.True); d = 3;
        return editor;
    }

    [Test]
    public void State_round_trips_exactly_and_the_rebuilt_mesh_behaves_the_same()
    {
        var editor = Square(out int a, out _, out _, out int d);
        editor.MoveNode(editor.Mesh.Hex(a).NodeIds[6], new Vec3(1.2, 1.1, 1.3), true);
        var state = editor.Mesh.ToState();

        var rebuilt = HexMesh.FromState(state);

        Assert.That(rebuilt.ToState().Nodes, Is.EquivalentTo(state.Nodes));
        Assert.That(rebuilt.ToState().Links, Is.EquivalentTo(state.Links));
        Assert.That(rebuilt.ToState().Hexes.Select(h => (h.Id, h.I, h.J, h.K)), Is.EquivalentTo(state.Hexes.Select(h => (h.Id, h.I, h.J, h.K))));
        Assert.That(rebuilt.ToState().NextNodeId, Is.EqualTo(state.NextNodeId));
        Assert.That(rebuilt.TryMapIdealToReal(new Vec3(0.4, 0.6, 0.5), out var r1), Is.True);
        Assert.That(editor.Mesh.TryMapIdealToReal(new Vec3(0.4, 0.6, 0.5), out var r2), Is.True);
        Assert.That(r1, Is.EqualTo(r2));
        Assert.That(rebuilt.OwnersOf(rebuilt.Hex(d).NodeIds[0]), Is.Not.Empty);
        // ids are never recycled after a rebuild
        var next = rebuilt.AddOnFace(a, HexFace.ZPlus);
        Assert.That(next.Id, Is.EqualTo(state.NextHexId));
    }

    [Test]
    public void Every_successful_command_is_one_undo_step_and_undo_redo_restore_exactly()
    {
        var editor = Square(out _, out _, out int c, out int d);
        var full = editor.Mesh.ToState();

        Assert.That(editor.LinkFaces(new FaceRef(d, HexFace.XPlus), new FaceRef(c, HexFace.XMinus), LinkFit.Strict).Ok, Is.True);
        var linked = editor.Mesh.ToState();
        Assert.That(linked.Nodes.Count, Is.LessThan(full.Nodes.Count));

        Assert.That(editor.Undo(), Is.True);
        Assert.That(editor.Mesh.ToState().Nodes, Is.EquivalentTo(full.Nodes));
        Assert.That(editor.Mesh.ToState().Links, Is.EquivalentTo(full.Links));
        Assert.That(editor.CanRedo, Is.True);

        Assert.That(editor.Redo(), Is.True);
        Assert.That(editor.Mesh.ToState().Nodes, Is.EquivalentTo(linked.Nodes));
        Assert.That(editor.Mesh.ToState().Links, Is.EquivalentTo(linked.Links));
    }

    [Test]
    public void A_failed_command_changes_nothing_and_adds_no_history()
    {
        var editor = Square(out int a, out _, out _, out _);
        var before = editor.Mesh.ToState();
        int version = editor.Version;

        Assert.That(editor.AddHexOnFace(a, HexFace.XPlus).Ok, Is.False);          // already linked
        Assert.That(editor.AddHexOnFace(99, HexFace.XPlus).Ok, Is.False);         // unknown hex
        Assert.That(editor.MoveNode(12345, new Vec3(1, 1, 1), true).Ok, Is.False); // unknown node
        Assert.That(editor.MoveNode(0, new Vec3(double.NaN, 0, 0), true).Ok, Is.False);
        Assert.That(editor.UnlinkFace(a, HexFace.ZMinus).Ok, Is.False);           // not linked
        Assert.That(editor.AddFirstHex().Ok, Is.False);                           // not empty

        Assert.That(editor.Mesh.ToState().Nodes, Is.EquivalentTo(before.Nodes));
        Assert.That(editor.Version, Is.EqualTo(version));
        Assert.That(editor.Undo(), Is.True);   // undoes the LAST GOOD command, not a failed one
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(3));
    }

    [Test]
    public void A_new_command_clears_the_redo_stack()
    {
        var editor = Square(out int a, out _, out _, out _);
        editor.Undo();
        Assert.That(editor.CanRedo, Is.True);

        editor.AddHexOnFace(a, HexFace.ZPlus);

        Assert.That(editor.CanRedo, Is.False);
        Assert.That(editor.Redo(), Is.False);
    }

    [Test]
    public void Undo_on_a_fresh_editor_does_nothing()
    {
        var editor = new HexMeshEditor();

        Assert.That(editor.Undo(), Is.False);
        Assert.That(editor.Redo(), Is.False);
        Assert.That(editor.CanUndo, Is.False);
    }

    [Test]
    public void Moving_a_node_with_and_without_carrying_midpoints()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var hex = editor.Mesh.Hex(0);
        var mid = editor.Mesh.Node(hex.NodeIds[8]).Position;

        editor.MoveNode(hex.NodeIds[0], new Vec3(-0.2, 0, 0), carryEdgeMidpoints: false);
        Assert.That(editor.Mesh.Node(hex.NodeIds[8]).Position, Is.EqualTo(mid));

        editor.MoveNode(hex.NodeIds[0], new Vec3(-0.4, 0, 0), carryEdgeMidpoints: true);
        Assert.That(editor.Mesh.Node(hex.NodeIds[8]).Position.X, Is.EqualTo(mid.X - 0.1).Within(1e-12));
    }

    [Test]
    public void Reset_empties_the_mesh_and_is_undoable()
    {
        var editor = Square(out _, out _, out _, out _);

        editor.Reset();
        Assert.That(editor.Mesh.Hexes, Is.Empty);

        editor.Undo();
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(4));
    }

    [Test]
    public void History_is_capped()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        for (int i = 0; i < 260; i++) editor.MoveNode(0, new Vec3(0.001 * i, 0, 0), false);

        int steps = 0;
        while (editor.Undo()) steps++;

        Assert.That(steps, Is.EqualTo(200));
    }
}

public class LinkHexesTests
{
    // A(0,0) B(1,0) C(1,1) D(0,1); D is linked to A only, so D-C touch without being neighbours.
    private static HexMeshEditor Square()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        editor.AddHexOnFace(1, HexFace.YPlus);
        editor.AddHexOnFace(0, HexFace.YPlus);
        return editor;
    }

    [Test]
    public void Two_touching_hexes_are_linked_without_naming_a_face_in_either_order()
    {
        var editor = Square();

        Assert.That(editor.LinkHexes(3, 2, LinkFit.Strict).Ok, Is.True);
        Assert.That(editor.Mesh.Neighbor(3, HexFace.XPlus), Is.EqualTo(2));
        Assert.That(editor.Mesh.Neighbor(2, HexFace.XMinus), Is.EqualTo(3));

        editor.UnlinkFace(3, HexFace.XPlus);
        Assert.That(editor.LinkHexes(2, 3, LinkFit.Strict).Ok, Is.True);   // reversed order finds the same face
        Assert.That(editor.Mesh.Neighbor(3, HexFace.XPlus), Is.EqualTo(2));
    }

    [Test]
    public void Linking_works_along_every_axis_direction()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        foreach (var face in new[] { HexFace.XMinus, HexFace.YMinus, HexFace.ZMinus, HexFace.ZPlus })
        {
            int id = editor.Mesh.Hexes.Count;
            editor.AddHexOnFace(0, face);
            editor.UnlinkFace(0, face);
            Assert.That(editor.LinkHexes(id, 0, LinkFit.Strict).Ok, Is.True, face.ToString());
            Assert.That(editor.Mesh.Neighbor(0, face), Is.EqualTo(id));
        }
    }

    [Test]
    public void Hexes_that_are_not_adjacent_or_are_already_linked_are_refused_with_a_reason()
    {
        var editor = Square();

        var diagonal = editor.LinkHexes(0, 2, LinkFit.Strict);
        Assert.That(diagonal.Ok, Is.False);
        Assert.That(diagonal.Error, Does.Contain("not adjacent"));
        Assert.That(editor.LinkHexes(0, 1, LinkFit.Strict).Error, Does.Contain("already linked"));
        Assert.That(editor.LinkHexes(0, 0, LinkFit.Strict).Ok, Is.False);
        Assert.That(editor.LinkHexes(0, 99, LinkFit.Strict).Error, Does.Contain("Unknown hex"));
        Assert.That(editor.LinkHexes(98, 0, LinkFit.Strict).Error, Does.Contain("Unknown hex"));
    }

    [Test]
    public void Adapt_fits_the_second_hex_onto_the_first_when_the_faces_have_drifted()
    {
        var editor = Square();
        var cFace = editor.Mesh.FaceNodeIds(new FaceRef(2, HexFace.XMinus)).Where(n => editor.Mesh.OwnersOf(n).All(o => o.Hex == 2));
        foreach (int n in cFace) editor.MoveNode(n, editor.Mesh.Node(n).Position + new Vec3(0.2, 0, 0), false);

        Assert.That(editor.LinkHexes(3, 2, LinkFit.Strict).Ok, Is.False);
        Assert.That(editor.LinkHexes(3, 2, LinkFit.AdaptSecond).Ok, Is.True);
    }

    [Test]
    public void Linking_hexes_is_one_undo_step()
    {
        var editor = Square();
        int nodes = editor.Mesh.Nodes.Count;

        editor.LinkHexes(3, 2, LinkFit.Strict);
        Assert.That(editor.Mesh.Nodes.Count, Is.LessThan(nodes));
        editor.Undo();

        Assert.That(editor.Mesh.Nodes.Count, Is.EqualTo(nodes));
        Assert.That(editor.Mesh.Neighbor(3, HexFace.XPlus), Is.Null);
    }
}
