using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

// Cubes whose faces were brought together by moving nodes, although their cells are not
// face-adjacent in the ideal lattice: three cubes around one edge. A(0,0,0) has B on its
// +X side and C on its +Y side; B and C touch only along the vertical edge x=1,y=1 until
// their facing faces are moved onto one common plane.
public class SeamTests
{
    private const int A = 0, B = 1, C = 2;

    private static HexMeshEditor Corner()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(A, HexFace.XPlus);   // B
        editor.AddHexOnFace(A, HexFace.YPlus);   // C
        return editor;
    }

    // Brings B's +Y face and C's +X face onto one diagonal plane through the shared vertical
    // edge (x=1, y=1): around that edge A keeps 90 degrees and B and C get 135 each, which is
    // how three cubes close up around an edge. Both faces end up with the same 8 positions.
    private static void PullBTopOntoCSide(HexMeshEditor editor)
    {
        static Vec3 Diagonal(double t, int g) => new(1 + 0.8 * t, 1 + 0.8 * t, (g + 1) / 2.0);
        var b = editor.Mesh.Hex(B);
        var c = editor.Mesh.Hex(C);
        foreach (int slot in HexFace.YPlus.Slots())
            editor.Mesh.SetNodePosition(b.NodeIds[slot], Diagonal((Hex20Reference.LocalCoords[slot, 0] + 1) / 2.0, Hex20Reference.LocalCoords[slot, 2]));
        foreach (int slot in HexFace.XPlus.Slots())
            editor.Mesh.SetNodePosition(c.NodeIds[slot], Diagonal((Hex20Reference.LocalCoords[slot, 1] + 1) / 2.0, Hex20Reference.LocalCoords[slot, 2]));
    }

    [Test]
    public void Three_cubes_around_an_edge_start_as_edge_contact_and_sharing_the_edge_nodes()
    {
        var editor = Corner();
        var b = editor.Mesh.Hex(B);
        var c = editor.Mesh.Hex(C);

        Assert.That(b.NodeIds[3], Is.EqualTo(c.NodeIds[1]));      // the shared vertical edge: nodes already joined through A
        Assert.That(editor.Mesh.GetFaceState(new FaceRef(C, HexFace.XPlus)).Status, Is.EqualTo(FaceStatus.Free));
        Assert.That(editor.LinkHexes(B, C, LinkFit.Strict).Ok, Is.False);
    }

    [Test]
    public void Once_the_faces_coincide_they_show_up_as_a_seam_candidate_on_both_sides()
    {
        var editor = Corner();
        PullBTopOntoCSide(editor);

        var cSide = editor.Mesh.GetFaceState(new FaceRef(C, HexFace.XPlus));
        var bSide = editor.Mesh.GetFaceState(new FaceRef(B, HexFace.YPlus));

        Assert.That(cSide.Status, Is.EqualTo(FaceStatus.Candidate));
        Assert.That(cSide.Seam, Is.True);
        Assert.That(cSide.Coincident, Is.True);
        Assert.That(cSide.Other, Is.EqualTo(new FaceRef(B, HexFace.YPlus)));
        Assert.That(bSide.Other, Is.EqualTo(new FaceRef(C, HexFace.XPlus)));
    }

    [Test]
    public void The_two_cubes_can_be_linked_by_selecting_just_the_cubes()
    {
        var editor = Corner();
        PullBTopOntoCSide(editor);

        var result = editor.LinkHexes(B, C, LinkFit.Strict);

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(editor.Mesh.Neighbor(B, HexFace.YPlus), Is.EqualTo(C));
        Assert.That(editor.Mesh.Neighbor(C, HexFace.XPlus), Is.EqualTo(B));
        Assert.That(editor.Mesh.IsSeam(B, HexFace.YPlus), Is.True);
        Assert.That(editor.Mesh.IsSeam(A, HexFace.XPlus), Is.False);
        foreach (var slot in HexFace.YPlus.Slots())
        {
            int partner = HexFace.YPlus.Partner(HexFace.XPlus, editor.Mesh.LinkOf(B, HexFace.YPlus)!.Value.Orientation, slot);
            Assert.That(editor.Mesh.Hex(B).NodeIds[slot], Is.EqualTo(editor.Mesh.Hex(C).NodeIds[partner]));
        }
    }

    [Test]
    public void A_seam_link_merges_the_eight_face_nodes_and_keeps_every_hex_valid()
    {
        var editor = Corner();
        PullBTopOntoCSide(editor);
        int before = editor.Mesh.Nodes.Count;

        editor.LinkHexes(B, C, LinkFit.Strict);

        Assert.That(editor.Mesh.Nodes.Count, Is.LessThan(before));
        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
        foreach (var node in editor.Mesh.Nodes)
            Assert.That(editor.Mesh.OwnersOf(node.Id), Is.Not.Empty);
    }

    [Test]
    public void The_seam_is_not_a_lattice_neighbour_so_the_ideal_cells_stay_apart()
    {
        var editor = Corner();
        PullBTopOntoCSide(editor);
        editor.LinkHexes(B, C, LinkFit.Strict);

        Assert.That(editor.Mesh.Hex(B).Cell, Is.EqualTo((1, 0, 0)));
        Assert.That(editor.Mesh.Hex(C).Cell, Is.EqualTo((0, 1, 0)));
        Assert.That(editor.Mesh.TryMapIdealToReal(new Vec3(1.5, 0.5, 0.5), out var inB), Is.True);
        Assert.That(editor.Mesh.TryMapIdealToReal(new Vec3(0.5, 1.5, 0.5), out var inC), Is.True);
        Assert.That(inB, Is.Not.EqualTo(inC));
    }

    [Test]
    public void Both_state_snapshots_and_undo_keep_the_seam_exactly()
    {
        var editor = Corner();
        PullBTopOntoCSide(editor);
        editor.LinkHexes(B, C, LinkFit.Strict);
        var linked = editor.Mesh.ToState();

        var rebuilt = HexMesh.FromState(linked);
        Assert.That(rebuilt.ToState().Links, Is.EquivalentTo(linked.Links));
        Assert.That(rebuilt.IsSeam(B, HexFace.YPlus), Is.True);

        editor.Undo();
        Assert.That(editor.Mesh.Neighbor(B, HexFace.YPlus), Is.Null);
        editor.Redo();
        Assert.That(editor.Mesh.Neighbor(B, HexFace.YPlus), Is.EqualTo(C));
        Assert.That(editor.Mesh.ToState().Links, Is.EquivalentTo(linked.Links));
    }

    [Test]
    public void Unlinking_a_seam_splits_the_face_nodes_that_only_it_joined()
    {
        var editor = Corner();
        PullBTopOntoCSide(editor);
        editor.LinkHexes(B, C, LinkFit.Strict);
        var b = editor.Mesh.Hex(B);
        int midOfFarEdge = b.NodeIds[HexFace.YPlus.SlotAt(1, 0)];    // a node only the seam joined
        int count = editor.Mesh.Nodes.Count;

        editor.UnlinkFace(B, HexFace.YPlus);

        Assert.That(editor.Mesh.Neighbor(B, HexFace.YPlus), Is.Null);
        Assert.That(editor.Mesh.Nodes.Count, Is.GreaterThan(count));
        Assert.That(editor.Mesh.OwnersOf(midOfFarEdge).Count, Is.EqualTo(1));
        // the shared vertical edge stays joined: A still links both
        Assert.That(editor.Mesh.Hex(B).NodeIds[3], Is.EqualTo(editor.Mesh.Hex(C).NodeIds[1]));
    }

    [Test]
    public void A_seam_counts_as_a_connection_when_checking_that_removal_keeps_the_body_whole()
    {
        var editor = Corner();
        PullBTopOntoCSide(editor);
        Assert.That(editor.RemoveHex(A).Ok, Is.False);          // B and C only meet through A
        editor.LinkHexes(B, C, LinkFit.Strict);

        Assert.That(editor.RemoveHex(A).Ok, Is.True);           // now the seam holds them together
        Assert.That(editor.Mesh.Neighbor(B, HexFace.YPlus), Is.EqualTo(C));
    }

    [Test]
    public void Faces_that_do_not_coincide_cannot_be_glued_and_the_message_gives_the_gap()
    {
        var editor = Corner();
        PullBTopOntoCSide(editor);
        var b = editor.Mesh.Hex(B);
        editor.Mesh.SetNodePosition(b.NodeIds[HexFace.YPlus.SlotAt(1, 1)], new Vec3(2.4, 2.4, 1));

        var result = editor.Mesh.TryLinkFaces(new FaceRef(C, HexFace.XPlus), new FaceRef(B, HexFace.YPlus), LinkFit.Strict, out var error);

        Assert.That(result, Is.False);
        Assert.That(error, Does.Contain("closest gap"));
    }

    [Test]
    public void Two_cubes_that_are_far_apart_with_no_coinciding_faces_are_refused_with_a_clear_message()
    {
        var editor = Corner();

        var result = editor.LinkHexes(B, C, LinkFit.Strict);

        Assert.That(result.Error, Does.Contain("only along an edge"));
        Assert.That(result.Error, Does.Contain("move nodes"));
    }

    [Test]
    public void Cubes_on_the_same_side_of_a_coinciding_face_cannot_be_glued()
    {
        // two hexes overlapping on a plane, both on the same side of it
        var editor = new HexMeshEditor();
        editor.AddFirstHex();                                   // A cell (0,0,0)
        editor.AddHexOnFace(0, HexFace.XPlus);                  // B cell (1,0,0)
        editor.UnlinkFace(0, HexFace.XPlus);
        var b = editor.Mesh.Hex(1);
        // move B's whole body so that its +X face lands exactly on A's +X face (B lies inside A's side)
        foreach (int slot in Enumerable.Range(0, 20))
        {
            var p = editor.Mesh.Node(b.NodeIds[slot]).Position;
            editor.Mesh.SetNodePosition(b.NodeIds[slot], new Vec3(p.X - 1, p.Y, p.Z));
        }

        var result = editor.Mesh.TryLinkFaces(new FaceRef(0, HexFace.XPlus), new FaceRef(1, HexFace.XPlus), LinkFit.Strict, out var error);

        Assert.That(result, Is.False);
        Assert.That(error, Does.Contain("same side"));
    }

    [Test]
    public void Face_orientation_helpers_are_consistent()
    {
        for (int g = 0; g < FaceOrientation.Count; g++)
        {
            int inverse = FaceOrientation.Inverse(g);
            foreach (var (u, v) in new[] { (1, 1), (-1, 0), (0, 1), (1, -1) })
            {
                var (u2, v2) = FaceOrientation.Apply(g, u, v);
                Assert.That(FaceOrientation.Apply(inverse, u2, v2), Is.EqualTo((u, v)));
            }
        }
        // lattice-opposite faces glue with the identity and agree with the old partner table
        foreach (var face in HexFaces.All)
            foreach (int slot in face.Slots())
                Assert.That(face.Partner(face.Opposite(), FaceOrientation.Identity, slot), Is.EqualTo(face.PartnerSlot(slot)));
        Assert.That(HexFace.XPlus.Partner(HexFace.XMinus, 0, 0), Is.EqualTo(-1));   // slot 0 is not on +X
        Assert.That(HexFace.XPlus.SlotAt(0, 0), Is.EqualTo(-1));                    // a face has no centre node
    }
}
