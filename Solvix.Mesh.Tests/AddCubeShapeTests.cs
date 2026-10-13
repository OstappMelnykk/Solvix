using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

// A cube added on a face is an extrusion of that face: its far face is the shared
// face pushed out along the face's normal by the host's thickness, nodes halfway
// along are half a step out. A deformation anywhere else in the host must never
// leak into the new cube (no extrapolation of the host's curved map).
public class AddCubeShapeTests
{
    private static bool Near(Vec3 a, Vec3 b, double tol = 1e-9) => (a - b).Length < tol;

    private static Vec3 Local(int slot) => new(Hex20Reference.LocalCoords[slot, 0], Hex20Reference.LocalCoords[slot, 1], Hex20Reference.LocalCoords[slot, 2]);

    // The regular unit cube whose lower corner is (x, y, z): every slot at its natural place.
    private static void AssertRegularCube(HexMesh mesh, Hex20 hex, Vec3 corner, string message = "")
    {
        for (int slot = 0; slot < 20; slot++)
        {
            var l = Local(slot);
            var expected = corner + new Vec3((l.X + 1) / 2, (l.Y + 1) / 2, (l.Z + 1) / 2);
            Assert.That(Near(mesh.Node(hex.NodeIds[slot]).Position, expected), Is.True, $"{message} slot {slot}: {mesh.Node(hex.NodeIds[slot]).Position} vs {expected}");
        }
    }

    [Test]
    public void On_a_regular_host_every_face_gives_an_exact_unit_cube()
    {
        foreach (var face in HexFaces.All)
        {
            var mesh = new HexMesh();
            var host = mesh.AddFirst();
            var (di, dj, dk) = face.Offset();

            var added = mesh.AddOnFace(host.Id, face);

            AssertRegularCube(mesh, added, new Vec3(di, dj, dk), face.ToString());
        }
    }

    [Test]
    public void Deforming_the_far_side_of_the_host_does_not_bend_the_new_cube()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        // wreck A's -X side: one corner pulled far away and four of that face's midpoints thrown about
        mesh.SetNodePosition(a.NodeIds[0], new Vec3(-2, -1.5, -1));
        mesh.SetNodePosition(a.NodeIds[11], new Vec3(-0.8, 0.9, -0.7));
        mesh.SetNodePosition(a.NodeIds[15], new Vec3(-0.3, 1.4, 1.9));
        mesh.SetNodePosition(a.NodeIds[16], new Vec3(-1.2, -0.4, 0.5));
        mesh.SetNodePosition(a.NodeIds[19], new Vec3(-0.6, 1.7, 0.2));

        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);
        var c = mesh.AddOnFace(b.Id, HexFace.XPlus);

        AssertRegularCube(mesh, b, new Vec3(1, 0, 0), "B");
        AssertRegularCube(mesh, c, new Vec3(2, 0, 0), "C");
    }

    [Test]
    public void A_cube_that_does_not_touch_the_curved_cube_stays_regular_down_the_chain()
    {
        // A is bent at its -X side, B is attached to A, C to B, D to C: C and D never touch A.
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        mesh.DragNode(a.NodeIds[3], new Vec3(-1, 3, 0));
        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);
        var c = mesh.AddOnFace(b.Id, HexFace.XPlus);
        var d = mesh.AddOnFace(c.Id, HexFace.YPlus);

        AssertRegularCube(mesh, c, new Vec3(2, 0, 0), "C");
        AssertRegularCube(mesh, d, new Vec3(2, 1, 0), "D");
    }

    [Test]
    public void A_deformed_shared_face_is_extruded_as_it_is()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        // skew A's +X face: pull one of its corners so the face is no longer a unit square (still planar x=1)
        mesh.SetNodePosition(a.NodeIds[2], new Vec3(1, 1.5, 0));    // (+,+,-) corner

        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);

        // far face = shared face + (1,0,0) (normal is +X, thickness 1); halfway nodes = + (0.5,0,0)
        foreach (int slot in Enumerable.Range(0, 20))
        {
            var l = Local(slot);
            if (l.X == -1) continue;                              // the shared face itself
            int counterpart = Enumerable.Range(0, 20).First(t => Local(t).X == -1 && Local(t).Y == l.Y && Local(t).Z == l.Z);
            var expected = mesh.Node(b.NodeIds[counterpart]).Position + new Vec3(l.X == 1 ? 1 : 0.5, 0, 0);
            Assert.That(Near(mesh.Node(b.NodeIds[slot]).Position, expected), Is.True, $"slot {slot}");
        }
        Assert.That(b.IsValid(), Is.True);
    }

    [Test]
    public void A_stretched_host_gives_a_child_as_thick_as_the_host()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        // stretch A along X to a beam 4 long: move its whole +X face (8 nodes) from x=1 to x=4, midpoints too
        foreach (int slot in HexFace.XPlus.Slots())
            mesh.SetNodePosition(a.NodeIds[slot], mesh.Node(a.NodeIds[slot]).Position + new Vec3(3, 0, 0));
        foreach (int slot in new[] { 8, 10, 12, 14 })             // x-midpoints of the beam's edges
            mesh.SetNodePosition(a.NodeIds[slot], mesh.Node(a.NodeIds[slot]).Position + new Vec3(1.5, 0, 0));

        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);

        Assert.That(mesh.Node(b.NodeIds[6]).Position.X, Is.EqualTo(8).Within(1e-9));    // far corner: 4 + 4
        Assert.That(mesh.Node(b.NodeIds[11]).Position.X, Is.EqualTo(4).Within(1e-9));   // shared midpoint on the x=4 face
        Assert.That(mesh.Node(b.NodeIds[9]).Position.X, Is.EqualTo(8).Within(1e-9));    // far-face midpoint
        Assert.That(mesh.Node(b.NodeIds[10]).Position.X, Is.EqualTo(6).Within(1e-9));   // halfway
        Assert.That(mesh.Node(b.NodeIds[2]).Position.Y, Is.EqualTo(1).Within(1e-9));
    }

    [Test]
    public void Negative_directions_extrude_outward_too()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        mesh.DragNode(a.NodeIds[6], new Vec3(2.5, 2.5, 2.5));      // wreck the opposite corner

        var below = mesh.AddOnFace(a.Id, HexFace.YMinus);
        var behind = mesh.AddOnFace(a.Id, HexFace.ZMinus);

        AssertRegularCube(mesh, below, new Vec3(0, -1, 0), "below");
        AssertRegularCube(mesh, behind, new Vec3(0, 0, -1), "behind");
    }

    [Test]
    public void A_sheared_host_still_gives_a_valid_child_attached_without_gaps()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        foreach (int slot in HexFace.YPlus.Slots())                // shear the top face sideways
            mesh.SetNodePosition(a.NodeIds[slot], mesh.Node(a.NodeIds[slot]).Position + new Vec3(0.6, 0, 0.2));

        var above = mesh.AddOnFace(a.Id, HexFace.YPlus);

        Assert.That(above.IsValid(), Is.True);
        Assert.That(mesh.InvalidHexes(), Is.Empty);
        foreach (int slot in HexFace.YPlus.Slots())
            Assert.That(above.NodeIds[HexFace.YMinus.Slots().First(s => HexFace.YPlus.PartnerSlot(slot) == s)], Is.EqualTo(a.NodeIds[slot]));
    }

    [Test]
    public void Moderately_deformed_hosts_give_valid_children_on_every_face()
    {
        var rng = new Random(9);
        for (int trial = 0; trial < 60; trial++)
        {
            var mesh = new HexMesh();
            var a = mesh.AddFirst();
            foreach (int slot in Enumerable.Range(0, 20))
                mesh.SetNodePosition(a.NodeIds[slot], mesh.Node(a.NodeIds[slot]).Position + new Vec3(rng.NextDouble() - 0.5, rng.NextDouble() - 0.5, rng.NextDouble() - 0.5) * 0.2);

            if (!a.IsValid()) continue;                          // a host that is already folded proves nothing
            var child = mesh.AddOnFace(a.Id, HexFaces.All[rng.Next(6)]);

            Assert.That(child.IsValid(), Is.True, $"trial {trial}");
        }
    }

    [Test]
    public void Even_a_wildly_deformed_host_never_flings_the_new_cube_far_away()
    {
        var rng = new Random(10);
        for (int trial = 0; trial < 60; trial++)
        {
            var mesh = new HexMesh();
            var a = mesh.AddFirst();
            foreach (int slot in Enumerable.Range(0, 20))
                mesh.SetNodePosition(a.NodeIds[slot], mesh.Node(a.NodeIds[slot]).Position + new Vec3(rng.NextDouble() - 0.5, rng.NextDouble() - 0.5, rng.NextDouble() - 0.5) * 0.8);

            var child = mesh.AddOnFace(a.Id, HexFaces.All[rng.Next(6)]);

            foreach (var id in child.NodeIds)
                Assert.That(mesh.Node(id).Position.Length, Is.LessThan(5), $"trial {trial}: a node flew away");
        }
    }

    [Test]
    public void The_ideal_world_position_of_a_new_cube_is_always_its_lattice_cell()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        mesh.DragNode(a.NodeIds[1], new Vec3(3, 3, 3));

        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);

        Assert.That(mesh.Node(b.NodeIds[6]).Ideal, Is.EqualTo((4, 2, 2)));
        Assert.That(mesh.Node(b.NodeIds[7]).Ideal, Is.EqualTo((2, 2, 2)));
    }
}
