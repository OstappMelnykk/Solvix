using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

public class FaceTests
{
    private static bool Near(Vec3 a, Vec3 b, double tol = 1e-9) => (a - b).Length < tol;

    // A(0,0) B(1,0) C(1,1) D(0,1); D is linked to A only.
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
    public void Face_states_tell_free_linked_and_candidate_apart()
    {
        var (mesh, a, b, c, d) = Square();

        Assert.That(mesh.GetFaceState(new FaceRef(a.Id, HexFace.XPlus)).Status, Is.EqualTo(FaceStatus.Linked));
        Assert.That(mesh.GetFaceState(new FaceRef(a.Id, HexFace.XMinus)).Status, Is.EqualTo(FaceStatus.Free));
        var candidate = mesh.GetFaceState(new FaceRef(d.Id, HexFace.XPlus));
        Assert.That(candidate.Status, Is.EqualTo(FaceStatus.Candidate));
        Assert.That(candidate.Other, Is.EqualTo(new FaceRef(c.Id, HexFace.XMinus)));
        Assert.That(candidate.Coincident, Is.True);
        Assert.That(candidate.Gap, Is.EqualTo(0).Within(1e-12));
        Assert.That(mesh.AllFaceStates(), Has.Count.EqualTo(4 * 6));
        Assert.That(b.Id, Is.Not.EqualTo(c.Id));
    }

    [Test]
    public void A_candidate_reports_the_gap_once_a_face_is_pulled_away()
    {
        var (mesh, _, _, _, d) = Square();
        var onlyD = mesh.FaceNodeIds(new FaceRef(d.Id, HexFace.XPlus)).First(n => mesh.OwnersOf(n).All(o => o.Hex == d.Id));
        mesh.SetNodePosition(onlyD, mesh.Node(onlyD).Position + new Vec3(0.3, 0, 0));

        var state = mesh.GetFaceState(new FaceRef(d.Id, HexFace.XPlus));

        Assert.That(state.Coincident, Is.False);
        Assert.That(state.Gap, Is.EqualTo(0.3).Within(1e-12));
    }

    [Test]
    public void Clicking_two_opposite_adjacent_faces_links_them()
    {
        var (mesh, _, _, c, d) = Square();

        Assert.That(mesh.TryLinkFaces(new FaceRef(d.Id, HexFace.XPlus), new FaceRef(c.Id, HexFace.XMinus), LinkFit.Strict, out var error), Is.True, error);
        Assert.That(mesh.GetFaceState(new FaceRef(d.Id, HexFace.XPlus)).Status, Is.EqualTo(FaceStatus.Linked));
    }

    [Test]
    public void Clicking_the_wrong_faces_is_refused_with_a_reason()
    {
        var (mesh, a, b, c, d) = Square();

        Assert.That(mesh.TryLinkFaces(new FaceRef(d.Id, HexFace.XPlus), new FaceRef(c.Id, HexFace.XPlus), LinkFit.Strict, out var e1), Is.False);
        Assert.That(e1, Does.Contain("coincide"));
        Assert.That(mesh.TryLinkFaces(new FaceRef(a.Id, HexFace.ZPlus), new FaceRef(c.Id, HexFace.XMinus), LinkFit.Strict, out var e2), Is.False);
        Assert.That(e2, Does.Contain("coincide"));
        Assert.That(mesh.TryLinkFaces(new FaceRef(a.Id, HexFace.XPlus), new FaceRef(b.Id, HexFace.XMinus), LinkFit.Strict, out var e3), Is.False);
        Assert.That(e3, Does.Contain("already linked"));
        Assert.That(mesh.TryLinkFaces(new FaceRef(a.Id, HexFace.XPlus), new FaceRef(a.Id, HexFace.XMinus), LinkFit.Strict, out _), Is.False);
    }

    [Test]
    public void Strict_link_refuses_a_gap_but_adapt_fits_the_second_face_and_links()
    {
        var (mesh, _, _, c, d) = Square();
        // pull C's whole near face (C owns these nodes only through B, so move the unshared ones)
        foreach (int n in mesh.FaceNodeIds(new FaceRef(c.Id, HexFace.XMinus)).Where(n => mesh.OwnersOf(n).All(o => o.Hex == c.Id)))
            mesh.SetNodePosition(n, mesh.Node(n).Position + new Vec3(0.2, 0.05, 0));
        var first = new FaceRef(d.Id, HexFace.XPlus);
        var second = new FaceRef(c.Id, HexFace.XMinus);

        Assert.That(mesh.TryLinkFaces(first, second, LinkFit.Strict, out _), Is.False);
        Assert.That(mesh.TryLinkFaces(first, second, LinkFit.AdaptSecond, out var error), Is.True, error);

        foreach (int s in HexFace.XPlus.Slots())
            Assert.That(d.NodeIds[s], Is.EqualTo(c.NodeIds[HexFace.XPlus.PartnerSlot(s)]));
        Assert.That(mesh.GetFaceState(first).Status, Is.EqualTo(FaceStatus.Linked));
    }

    [Test]
    public void Adapt_keeps_the_far_face_of_the_second_hex_in_place_and_blends_the_middle()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);
        mesh.Unlink(a.Id, HexFace.XPlus);
        // offset all of B's slots so its near face is 0.4 away from A's far face
        foreach (var n in mesh.Nodes.Where(n => mesh.OwnersOf(n.Id).All(o => o.Hex == b.Id)).ToList())
            mesh.SetNodePosition(n.Id, n.Position);
        foreach (int s in HexFace.XMinus.Slots())
            mesh.SetNodePosition(b.NodeIds[s], mesh.Node(b.NodeIds[s]).Position + new Vec3(0.4, 0, 0));
        var far = Enumerable.Range(0, 20).Where(s => Hex20Reference.LocalCoords[s, 0] == 1).ToDictionary(s => s, s => mesh.Node(b.NodeIds[s]).Position);
        var mid = mesh.Node(b.NodeIds[8]).Position;   // x-axis edge midpoint of B, half-way along

        Assert.That(mesh.TryLinkFaces(new FaceRef(a.Id, HexFace.XPlus), new FaceRef(b.Id, HexFace.XMinus), LinkFit.AdaptSecond, out var error), Is.True, error);

        foreach (var (s, p) in far) Assert.That(Near(mesh.Node(b.NodeIds[s]).Position, p), Is.True);
        Assert.That(Near(mesh.Node(b.NodeIds[8]).Position, mid - new Vec3(0.2, 0, 0)), Is.True);
        Assert.That(b.IsValid(), Is.True);
    }

    [Test]
    public void Linking_already_coincident_faces_with_adapt_changes_nothing()
    {
        var (mesh, _, _, c, d) = Square();
        var before = mesh.Nodes.ToDictionary(n => n.Id, n => n.Position);

        Assert.That(mesh.TryLinkFaces(new FaceRef(d.Id, HexFace.XPlus), new FaceRef(c.Id, HexFace.XMinus), LinkFit.AdaptSecond, out _), Is.True);

        foreach (var n in mesh.Nodes) Assert.That(n.Position, Is.EqualTo(before[n.Id]));
    }
}
