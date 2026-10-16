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
    public void Moving_a_face_shifts_its_8_nodes_fully_and_the_connecting_midpoints_by_half()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var hex = editor.Mesh.Hex(0);
        var face = HexFace.XPlus;

        // Snapshot every node position before the move.
        var before = Enumerable.Range(0, 20).ToDictionary(s => s, s => editor.Mesh.Node(hex.NodeIds[s]).Position);
        var delta = new Vec3(0.3, 0, 0);

        Assert.That(editor.MoveFace(new FaceRef(0, face), delta).Ok, Is.True);

        var onFace = face.Slots().ToHashSet();
        // The 8 nodes on the face move by the full delta.
        foreach (int s in onFace)
            Assert.That(editor.Mesh.Node(hex.NodeIds[s]).Position, Is.EqualTo(before[s] + delta), $"slot {s} should move fully");

        // Midpoints of the connecting edges (one corner on the face, one off) move by half.
        for (int k = 0; k < Hex20Reference.EdgeCorners.Length; k++)
        {
            var (ca, cb) = Hex20Reference.EdgeCorners[k];
            int mid = 8 + k;
            if (onFace.Contains(mid)) continue; // already covered as an on-face node
            bool connecting = onFace.Contains(ca) ^ onFace.Contains(cb);
            var expected = before[mid] + (connecting ? delta * 0.5 : Vec3.Zero);
            var actual = editor.Mesh.Node(hex.NodeIds[mid]).Position;
            Assert.That((actual - expected).Length, Is.LessThan(1e-12), $"midpoint slot {mid}");
        }
    }

    [Test]
    public void Moving_a_shared_face_keeps_the_edges_of_the_linked_neighbour_straight_too()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        var delta = new Vec3(0.4, 0.1, -0.2);

        Assert.That(editor.MoveFace(new FaceRef(0, HexFace.XPlus), delta).Ok, Is.True);

        // every edge of every cube still has its midpoint where a straight edge has it
        foreach (var hex in editor.Mesh.Hexes)
            for (int k = 0; k < Hex20Reference.EdgeCorners.Length; k++)
            {
                var (ca, cb) = Hex20Reference.EdgeCorners[k];
                var a = editor.Mesh.Node(hex.NodeIds[ca]).Position;
                var b = editor.Mesh.Node(hex.NodeIds[cb]).Position;
                var mid = editor.Mesh.Node(hex.NodeIds[8 + k]).Position;
                Assert.That((mid - (a + b) * 0.5).Length, Is.LessThan(1e-12), $"cube {hex.Id}, edge {k} is bent");
            }
    }

    [Test]
    public void Moving_a_face_is_one_undo_step_and_fails_on_bad_input()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var before = editor.Mesh.ToState();

        Assert.That(editor.MoveFace(new FaceRef(0, HexFace.ZPlus), new Vec3(0, 0, 0.5)).Ok, Is.True);
        Assert.That(editor.Undo(), Is.True);
        Assert.That(editor.Mesh.ToState().Nodes, Is.EquivalentTo(before.Nodes));

        Assert.That(editor.MoveFace(new FaceRef(99, HexFace.ZPlus), new Vec3(0, 0, 1)).Ok, Is.False);   // unknown hex
        Assert.That(editor.MoveFace(new FaceRef(0, HexFace.ZPlus), new Vec3(double.NaN, 0, 0)).Ok, Is.False); // not finite
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
        Assert.That(diagonal.Error, Does.Contain("not across a face"));
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

public class RemoveHexTests
{
    // A(0,0) B(1,0) C(1,1) D(0,1), all four linked in a ring.
    private static HexMeshEditor Ring()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        editor.AddHexOnFace(1, HexFace.YPlus);
        editor.AddHexOnFace(0, HexFace.YPlus);
        Assert.That(editor.LinkHexes(3, 2, LinkFit.Strict).Ok, Is.True);
        return editor;
    }

    [Test]
    public void Removing_a_leaf_drops_its_own_nodes_and_keeps_the_shared_ones()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);

        Assert.That(editor.RemoveHex(1).Ok, Is.True);

        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(1));
        Assert.That(editor.Mesh.Nodes.Count, Is.EqualTo(20));
        Assert.That(editor.Mesh.HexAtCell((1, 0, 0)), Is.Null);
        Assert.That(editor.Mesh.Neighbor(0, HexFace.XPlus), Is.Null);
        Assert.That(editor.Mesh.OwnersOf(editor.Mesh.Hex(0).NodeIds[1]).Count, Is.EqualTo(1));
    }

    [Test]
    public void A_bridge_cube_cannot_be_removed_and_the_reason_names_the_parts()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        editor.AddHexOnFace(1, HexFace.XPlus);   // chain 0-1-2
        var before = editor.Mesh.ToState();

        var result = editor.RemoveHex(1);

        Assert.That(result.Ok, Is.False);
        Assert.That(result.Error, Does.Contain("split the body into 2 parts"));
        Assert.That(editor.Mesh.ToState().Nodes, Is.EquivalentTo(before.Nodes));
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(3));
    }

    [Test]
    public void A_branching_hub_cannot_be_removed()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        editor.AddHexOnFace(0, HexFace.YPlus);    // B and C hang off A but are not linked to each other

        Assert.That(editor.RemoveHex(0).Ok, Is.False);
        Assert.That(editor.RemoveHex(1).Ok, Is.True);
    }

    [Test]
    public void In_a_ring_any_cube_can_go_because_the_rest_stays_connected()
    {
        var editor = Ring();

        Assert.That(editor.RemoveHex(1).Ok, Is.True);
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(3));
        Assert.That(editor.Mesh.ComponentSizesWithout(0), Has.Count.EqualTo(1));   // the chain A-D-C: A is a leaf
        Assert.That(editor.Mesh.ComponentSizesWithout(3), Has.Count.EqualTo(2));   // D is now the bridge
    }

    [Test]
    public void The_last_cube_can_be_removed_and_a_first_cube_can_be_added_again_with_fresh_ids()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();

        Assert.That(editor.RemoveHex(0).Ok, Is.True);
        Assert.That(editor.Mesh.Hexes, Is.Empty);
        Assert.That(editor.Mesh.Nodes, Is.Empty);

        Assert.That(editor.AddFirstHex().Ok, Is.True);
        Assert.That(editor.Mesh.Hexes.Single().Id, Is.EqualTo(1));   // ids are never reused
    }

    [Test]
    public void Unknown_hex_is_refused()
    {
        Assert.That(new HexMeshEditor().RemoveHex(5).Error, Does.Contain("Unknown hex"));
    }

    [Test]
    public void Removal_is_one_undo_step_and_undo_brings_everything_back()
    {
        var editor = Ring();
        var before = editor.Mesh.ToState();

        editor.RemoveHex(3);
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(3));
        editor.Undo();

        Assert.That(editor.Mesh.ToState().Nodes, Is.EquivalentTo(before.Nodes));
        Assert.That(editor.Mesh.ToState().Links, Is.EquivalentTo(before.Links));
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(4));
    }

    // A(0,0,0) X(1,0,0) C(1,1,0): A and C touch along one vertical edge, joined only through X
    // there - plus a path A-Z1-Z2-Z3-C over the top, so the body stays whole without X.
    private static HexMeshEditor EdgeContact()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();                             // 0 = A
        editor.AddHexOnFace(0, HexFace.XPlus);            // 1 = X
        editor.AddHexOnFace(1, HexFace.YPlus);            // 2 = C
        editor.AddHexOnFace(0, HexFace.ZPlus);            // 3 = Z1
        editor.AddHexOnFace(3, HexFace.YPlus);            // 4 = Z2
        editor.AddHexOnFace(4, HexFace.XPlus);            // 5 = Z3
        Assert.That(editor.LinkHexes(5, 2, LinkFit.Strict).Ok, Is.True);
        return editor;
    }

    [Test]
    public void Nodes_that_two_cubes_shared_only_through_the_removed_cube_are_split_again()
    {
        var editor = EdgeContact();
        var a = editor.Mesh.Hex(0);
        var c = editor.Mesh.Hex(2);
        // the vertical edge x=1,y=1: bottom corner, midpoint, and top corner
        int bottomA = a.NodeIds[2], midA = a.NodeIds[18], topA = a.NodeIds[6];
        int bottomC = c.NodeIds[0], midC = c.NodeIds[16], topC = c.NodeIds[4];
        Assert.That((bottomA, midA, topA), Is.EqualTo((bottomC, midC, topC)));
        var bottomPosition = editor.Mesh.Node(bottomA).Position;

        Assert.That(editor.RemoveHex(1).Ok, Is.True);

        Assert.That(a.NodeIds[2], Is.Not.EqualTo(c.NodeIds[0]));      // only X joined them: now independent
        Assert.That(a.NodeIds[18], Is.Not.EqualTo(c.NodeIds[16]));
        Assert.That(a.NodeIds[6], Is.EqualTo(c.NodeIds[4]));          // still joined through the top path
        Assert.That(editor.Mesh.Node(a.NodeIds[2]).Position, Is.EqualTo(bottomPosition));
        Assert.That(editor.Mesh.Node(c.NodeIds[0]).Position, Is.EqualTo(bottomPosition));
        foreach (var node in editor.Mesh.Nodes)
            Assert.That(editor.Mesh.OwnersOf(node.Id), Is.Not.Empty);
    }

    [Test]
    public void The_mesh_stays_consistent_after_removals_every_node_is_owned_and_ids_resolve()
    {
        var editor = EdgeContact();
        editor.RemoveHex(1);
        editor.RemoveHex(5);

        var state = editor.Mesh.ToState();
        var nodeIds = state.Nodes.Select(n => n.Id).ToHashSet();
        foreach (var hex in state.Hexes)
            foreach (int id in hex.NodeIds) Assert.That(nodeIds.Contains(id), Is.True);
        foreach (var node in editor.Mesh.Nodes)
            Assert.That(editor.Mesh.OwnersOf(node.Id).All(o => editor.Mesh.Hex(o.Hex).NodeIds[o.Slot] == node.Id), Is.True);
        Assert.That(editor.Mesh.ToFemMesh().ElementCount, Is.EqualTo(state.Hexes.Count));
    }
}

public class LinkRefusalMessageTests
{
    [Test]
    public void Cubes_touching_along_an_edge_get_an_explanation_not_just_a_refusal()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        editor.AddHexOnFace(1, HexFace.YPlus);   // 0 and 2 touch along an edge only

        var result = editor.LinkHexes(0, 2, LinkFit.Strict);

        Assert.That(result.Ok, Is.False);
        Assert.That(result.Error, Does.Contain("only along an edge"));
        Assert.That(result.Error, Does.Contain("add a hex that touches both"));
    }

    [Test]
    public void Cubes_touching_at_a_corner_and_far_apart_are_told_apart()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        editor.AddHexOnFace(1, HexFace.YPlus);
        editor.AddHexOnFace(2, HexFace.ZPlus);   // cell (1,1,1): corner contact with 0 at (0,0,0)
        editor.AddHexOnFace(3, HexFace.XPlus);   // cell (2,1,1): far from 0

        Assert.That(editor.LinkHexes(0, 3, LinkFit.Strict).Error, Does.Contain("only at a corner"));
        Assert.That(editor.LinkHexes(0, 4, LinkFit.Strict).Error, Does.Contain("not adjacent in the ideal lattice"));
    }

    [Test]
    public void The_edge_nodes_of_two_cubes_that_touch_along_an_edge_are_already_shared_through_their_neighbour()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        editor.AddHexOnFace(1, HexFace.YPlus);

        var a = editor.Mesh.Hex(0);
        var c = editor.Mesh.Hex(2);

        Assert.That(a.NodeIds[2], Is.EqualTo(c.NodeIds[0]));     // bottom of the shared vertical edge
        Assert.That(a.NodeIds[18], Is.EqualTo(c.NodeIds[16]));   // its midpoint
        Assert.That(a.NodeIds[6], Is.EqualTo(c.NodeIds[4]));     // its top
    }
}
