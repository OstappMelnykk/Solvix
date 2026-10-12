using NUnit.Framework;

namespace Solvix.Mesh.Tests;

[TestFixture]
public class SmoothTests
{
    // a 3 x 3 x 3 body whose real coordinate along each axis is a piecewise-linear function of the lattice one
    private static HexMeshEditor Body(Func<int, double> along)
    {
        double F(double t)
        {
            int i = (int)Math.Floor(t);
            return i >= 3 ? along(3) : along(i) + (t - i) * (along(i + 1) - along(i));
        }
        var cells = new List<BodyCell>();
        for (int i = 0; i < 3; i++)
            for (int j = 0; j < 3; j++)
                for (int k = 0; k < 3; k++)
                {
                    var positions = Enumerable.Range(0, Hex20Reference.NodeCount).Select(s =>
                        new Vec3(F(i + (Hex20Reference.LocalCoords[s, 0] + 1) / 2.0), F(j + (Hex20Reference.LocalCoords[s, 1] + 1) / 2.0), F(k + (Hex20Reference.LocalCoords[s, 2] + 1) / 2.0))).ToList();
                    cells.Add(new BodyCell(i, j, k, positions));
                }
        var editor = new HexMeshEditor();
        Assert.That(editor.AddBody(new BodyPlan(cells)).Ok, Is.True);
        return editor;
    }

    // one of the 8 vertices inside the body: the lattice point (1, 1, 1), in doubled ideal units (2, 2, 2)
    private static MeshNode Centre(HexMesh mesh) => mesh.Nodes.Single(n => n.Ideal == (2, 2, 2));

    [Test]
    public void A_displaced_interior_vertex_goes_back_to_its_place()
    {
        var editor = Body(t => t);
        var centre = Centre(editor.Mesh);
        Assert.That(editor.MoveNode(centre.Id, new Vec3(1.3, 0.8, 1.25), carryEdgeMidpoints: true).Ok, Is.True);

        var result = editor.Smooth(60, 0.5);

        Assert.That(result.Ok, Is.True, result.Error);
        var p = Centre(editor.Mesh).Position;
        Assert.That(new[] { p.X - 1, p.Y - 1, p.Z - 1 }.Select(Math.Abs).Max(), Is.LessThan(1e-3));
        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void The_boundary_does_not_move()
    {
        var editor = Body(t => t);
        var centre = Centre(editor.Mesh);
        editor.MoveNode(centre.Id, new Vec3(1.3, 0.8, 1.25), true);
        var before = editor.Mesh.Nodes.ToDictionary(n => n.Id, n => n.Position);

        editor.Smooth(20, 0.5);

        // only nodes strictly inside the body change: none lies on its outer surface (a doubled lattice coordinate 0 or 6)
        var changed = editor.Mesh.Nodes.Where(n => (n.Position - before[n.Id]).Length > 1e-12).ToList();
        Assert.That(changed, Is.Not.Empty);
        Assert.That(changed.Any(n => new[] { n.Ideal.X, n.Ideal.Y, n.Ideal.Z }.Any(c => c == 0 || c == 6)), Is.False);
    }

    [Test]
    public void A_graded_mesh_keeps_its_density()
    {
        // spacings 1/3, 1, 5/3 along every axis: a fine region next to a coarse one
        var editor = Body(t => t * t / 3.0);
        var before = editor.Mesh.Nodes.ToDictionary(n => n.Id, n => n.Position);

        var result = editor.Smooth(40, 0.5);

        // already relaxed in the weighted sense, so nothing moves: a plain average would drag it to uniform spacing
        Assert.That(result.Ok, Is.False);
        Assert.That(editor.Mesh.Nodes.Max(n => (n.Position - before[n.Id]).Length), Is.LessThan(1e-9));
    }

    [Test]
    public void A_graded_mesh_with_a_sideways_error_is_straightened_without_changing_the_spacing_along_the_line()
    {
        var editor = Body(t => t * t / 3.0);
        var centre = Centre(editor.Mesh);
        double x = centre.Position.X, y = centre.Position.Y, z = centre.Position.Z;
        editor.MoveNode(centre.Id, new Vec3(x, y + 0.2, z - 0.15), true);       // sideways only

        editor.Smooth(80, 0.5);

        var p = Centre(editor.Mesh).Position;
        Assert.That(p.X, Is.EqualTo(x).Within(1e-6));                       // the spacing along x is the one it had
        Assert.That(p.Y, Is.EqualTo(y).Within(1e-3));
        Assert.That(p.Z, Is.EqualTo(z).Within(1e-3));
    }

    [Test]
    public void A_single_cube_has_nothing_to_smooth_and_the_command_says_so()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();

        var result = editor.Smooth(5, 0.5);

        Assert.That(result.Ok, Is.False);
        Assert.That(result.Error, Does.Contain("Nothing to smooth"));
    }

    [Test]
    public void Smoothing_can_be_undone()
    {
        var editor = Body(t => t);
        var centre = Centre(editor.Mesh);
        editor.MoveNode(centre.Id, new Vec3(1.3, 0.8, 1.25), true);
        editor.Smooth(30, 0.5);

        Assert.That(editor.Undo(), Is.True);

        Assert.That(Centre(editor.Mesh).Position, Is.EqualTo(new Vec3(1.3, 0.8, 1.25)));
    }

    [Test]
    public void A_step_that_would_fold_a_cube_is_not_taken()
    {
        var editor = Body(t => t);
        var centre = Centre(editor.Mesh);
        // almost on the face of the body: the Laplacian wants to pull it back, never through a neighbour
        editor.MoveNode(centre.Id, new Vec3(1.9, 1.0, 1.0), true);

        editor.Smooth(100, 1.0);

        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void The_command_refuses_nonsense_settings()
    {
        var editor = Body(t => t);

        Assert.That(editor.Smooth(0, 0.5).Ok, Is.False);
        Assert.That(editor.Smooth(5, 0).Ok, Is.False);
        Assert.That(editor.Smooth(5, 1.5).Ok, Is.False);
    }
}
