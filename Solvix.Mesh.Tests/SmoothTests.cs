using NUnit.Framework;

namespace Solvix.Mesh.Tests;

[TestFixture]
public class SmoothTests
{
    // a 3 x 3 x 3 body whose real coordinate along each axis is a piecewise-linear function of the lattice one
    private static HexMeshEditor Body(Func<int, double> along, int nx = 3, int ny = 3, int nz = 3)
    {
        double F(double t, int count)
        {
            int i = (int)Math.Floor(t);
            return i >= count ? along(count) : along(i) + (t - i) * (along(i + 1) - along(i));
        }
        var cells = new List<BodyCell>();
        for (int i = 0; i < nx; i++)
            for (int j = 0; j < ny; j++)
                for (int k = 0; k < nz; k++)
                {
                    var positions = Enumerable.Range(0, Hex20Reference.NodeCount).Select(s =>
                        new Vec3(F(i + (Hex20Reference.LocalCoords[s, 0] + 1) / 2.0, nx), F(j + (Hex20Reference.LocalCoords[s, 1] + 1) / 2.0, ny), F(k + (Hex20Reference.LocalCoords[s, 2] + 1) / 2.0, nz))).ToList();
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
        Assert.That(result.Error, Does.Contain("too thin"));
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

    // ---- the surface ----

    // the top-face vertex above the middle of the 3 x 3 x 1 slab: the lattice point (1, 1, 1)
    private static MeshNode SlabVertex(HexMesh mesh) => mesh.Nodes.Single(n => n.Ideal == (2, 2, 2));

    [Test]
    public void A_thin_slab_has_no_interior_vertices_so_it_needs_the_surface_option()
    {
        var editor = Body(t => t, 3, 3, 1);
        editor.MoveNode(SlabVertex(editor.Mesh).Id, new Vec3(1.3, 0.8, 1.0), true);

        var interiorOnly = editor.Smooth(20, 0.5);

        Assert.That(interiorOnly.Ok, Is.False);
        Assert.That(interiorOnly.Error, Does.Contain("too thin"));
        Assert.That(editor.Smooth(60, 0.5, surface: true).Ok, Is.True);
        var p = SlabVertex(editor.Mesh).Position;
        Assert.That(p.X, Is.EqualTo(1).Within(1e-3));
        Assert.That(p.Y, Is.EqualTo(1).Within(1e-3));
    }

    [Test]
    public void A_surface_vertex_slides_along_the_surface_and_never_off_it()
    {
        var editor = Body(t => t, 3, 3, 1);
        editor.MoveNode(SlabVertex(editor.Mesh).Id, new Vec3(1.3, 0.8, 1.0), true);       // sideways, in the plane of the top face

        editor.Smooth(60, 0.5, surface: true);

        var p = SlabVertex(editor.Mesh).Position;
        Assert.That(p.Z, Is.EqualTo(1.0).Within(1e-9));                        // the height above the surface is not touched
        Assert.That(p.X, Is.EqualTo(1).Within(1e-3));
    }

    [Test]
    public void A_bump_in_the_surface_is_not_flattened_by_the_smoothing()
    {
        var editor = Body(t => t, 3, 3, 1);
        editor.MoveNode(SlabVertex(editor.Mesh).Id, new Vec3(1.0, 1.0, 1.1), true);       // a bump straight up

        editor.Smooth(60, 0.5, surface: true);

        // only a slide along the surface, so the height is what the user made it (the surface is not shrunk to a plane)
        Assert.That(SlabVertex(editor.Mesh).Position.Z, Is.EqualTo(1.1).Within(0.02));
    }

    [Test]
    public void Ridges_and_corners_of_the_body_stay_where_they_are_when_the_surface_is_smoothed()
    {
        var editor = Body(t => t, 3, 3, 1);
        var edgeNodes = editor.Mesh.Nodes.Where(n => n.Ideal.X == 0 || n.Ideal.X == 6 || n.Ideal.Y == 0 || n.Ideal.Y == 6).ToDictionary(n => n.Id, n => n.Position);
        editor.MoveNode(SlabVertex(editor.Mesh).Id, new Vec3(1.3, 0.8, 1.0), true);

        editor.Smooth(60, 0.5, surface: true);

        foreach (var (id, position) in edgeNodes) Assert.That((editor.Mesh.Node(id).Position - position).Length, Is.LessThan(1e-12));
    }

    [Test]
    public void Surface_smoothing_of_a_body_with_nothing_free_says_so()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();

        var result = editor.Smooth(5, 0.5, surface: true);

        Assert.That(result.Ok, Is.False);
        Assert.That(result.Error, Does.Contain("ridge or a corner"));
    }

    // ---- the rough block of the template library ----

    private static HexMeshEditor Rough(params (string, double)[] values) =>
        Build2("rough-block", values.ToDictionary(v => v.Item1, v => v.Item2));

    private static HexMeshEditor Build2(string kind, Dictionary<string, double> values)
    {
        var editor = new HexMeshEditor();
        Assert.That(editor.AddBody(HexTemplates.Kind(kind).Build(values)).Ok, Is.True);
        return editor;
    }

    // how far the nodes are from where a regular 5 x 5 x 5 block would have them
    private static double Spread(HexMesh mesh) =>
        mesh.Nodes.Average(n => (n.Position - new Vec3(n.Ideal.X / 2.0, n.Ideal.Y / 2.0, n.Ideal.Z / 2.0)).Length);

    [Test]
    public void The_rough_block_is_a_valid_box_with_shaken_inner_vertices()
    {
        var mesh = Rough().Mesh;

        Assert.That(mesh.InvalidHexes(), Is.Empty);
        Assert.That(Spread(mesh), Is.GreaterThan(0.03));
        // the outside is a plain box
        Assert.That(mesh.Nodes.Where(n => n.Ideal.X == 0).All(n => Math.Abs(n.Position.X) < 1e-12), Is.True);
        Assert.That(mesh.Nodes.Where(n => n.Ideal.Y == 10).All(n => Math.Abs(n.Position.Y - 5) < 1e-12), Is.True);
    }

    [Test]
    public void The_same_seed_gives_the_same_body_and_another_seed_another_one()
    {
        var a = Rough(("seed", 7)).Mesh.Nodes.Select(n => n.Position).ToList();
        var b = Rough(("seed", 7)).Mesh.Nodes.Select(n => n.Position).ToList();
        var c = Rough(("seed", 8)).Mesh.Nodes.Select(n => n.Position).ToList();

        Assert.That(a, Is.EqualTo(b));
        Assert.That(a, Is.Not.EqualTo(c));
        Assert.That(Spread(Rough(("jitter", 0)).Mesh), Is.LessThan(1e-12));
    }

    [Test]
    public void Smoothing_straightens_the_rough_block()
    {
        var editor = Rough();
        double before = Spread(editor.Mesh);

        Assert.That(editor.Smooth(100, 0.5).Ok, Is.True);

        Assert.That(Spread(editor.Mesh), Is.LessThan(before * 0.1));
        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
    }

    // ---- the settings the user controls ----

    [Test]
    public void With_the_density_weight_off_the_smoothing_is_the_plain_Laplacian_and_evens_the_spacing_out()
    {
        var editor = Body(t => t * t / 3.0);
        var before = editor.Mesh.Nodes.ToDictionary(n => n.Id, n => n.Position);

        var result = editor.Smooth(40, 0.5, density: 0);

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(editor.Mesh.Nodes.Max(n => (n.Position - before[n.Id]).Length), Is.GreaterThan(0.05));
    }

    [Test]
    public void A_wider_feature_angle_lets_more_of_the_surface_slide()
    {
        int Free(double featureAngle)
        {
            var editor = Body(t => t, 3, 3, 1);
            editor.MoveNode(SlabVertex(editor.Mesh).Id, new Vec3(1.0, 1.0, 1.5), true);       // a tall bump: the normals around it tilt
            return editor.Mesh.Smooth(1, 0.5, surface: true, featureAngle: featureAngle).Surface;
        }

        Assert.That(Free(5), Is.LessThan(Free(60)));
    }

    [Test]
    public void The_command_refuses_a_density_weight_or_a_feature_angle_out_of_range()
    {
        var editor = Body(t => t);

        Assert.That(editor.Smooth(5, 0.5, density: 1.5).Ok, Is.False);
        Assert.That(editor.Smooth(5, 0.5, density: -0.1).Ok, Is.False);
        Assert.That(editor.Smooth(5, 0.5, featureAngle: 0).Ok, Is.False);
        Assert.That(editor.Smooth(5, 0.5, featureAngle: 120).Ok, Is.False);
    }

    [Test]
    public void The_result_says_how_many_vertices_were_free_and_how_far_they_went()
    {
        var editor = Body(t => t);
        editor.MoveNode(Centre(editor.Mesh).Id, new Vec3(1.3, 0.8, 1.25), true);

        var result = editor.Smooth(20, 0.5);

        Assert.That(result.Info, Does.Contain("вільних вершин"));
        Assert.That(result.Info, Does.Contain("внутрішніх 8"));       // the 8 inner vertices of a 3 x 3 x 3 body
        Assert.That(result.Info, Does.Contain("на поверхні 0"));
    }

    // ---- folded cubes ----

    // the vertex (1, 1, 1) pulled out past its neighbour at x = 2: the cubes around it fold
    private static HexMeshEditor Folded()
    {
        var editor = Body(t => t);
        editor.MoveNode(Centre(editor.Mesh).Id, new Vec3(2.6, 1.0, 1.0), true);
        Assert.That(editor.Mesh.InvalidHexes(), Is.Not.Empty);
        return editor;
    }

    [Test]
    public void Smoothing_unfolds_cubes_that_were_folded()
    {
        var editor = Folded();
        int before = editor.Mesh.InvalidHexes().Count;

        var result = editor.Smooth(100, 0.5);

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
        Assert.That(result.Info, Does.Contain($"Вивернутих кубів: було {before}, стало 0"));
    }

    [Test]
    public void The_corners_of_a_folded_cube_on_the_surface_move_too_so_that_it_can_unfold()
    {
        // a vertex on the top surface of a slab, thrown through its neighbours
        var editor = Body(t => t, 3, 3, 1);
        editor.MoveNode(SlabVertex(editor.Mesh).Id, new Vec3(2.6, 1.0, 1.0), true);
        Assert.That(editor.Mesh.InvalidHexes(), Is.Not.Empty);

        var result = editor.Smooth(100, 0.5);

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void With_unfolding_off_a_folded_cube_on_the_surface_is_left_alone()
    {
        var editor = Body(t => t, 3, 3, 1);
        editor.MoveNode(SlabVertex(editor.Mesh).Id, new Vec3(2.6, 1.0, 1.0), true);

        var result = editor.Smooth(100, 0.5, untangle: false);

        Assert.That(result.Ok, Is.False);                           // the surface is not touched, and the slab has no inside
        Assert.That(editor.Mesh.InvalidHexes(), Is.Not.Empty);
    }
}
