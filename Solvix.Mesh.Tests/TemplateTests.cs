using NUnit.Framework;

namespace Solvix.Mesh.Tests;

public class TemplateTests
{
    private static HexMeshEditor Build(string kind, IReadOnlyDictionary<string, double>? values = null)
    {
        var editor = new HexMeshEditor();
        var result = editor.AddBody(HexTemplates.Kind(kind).Build(values));
        Assert.That(result.Ok, Is.True, result.Error);
        return editor;
    }

    private static Dictionary<string, double> V(params (string, double)[] values) => values.ToDictionary(v => v.Item1, v => v.Item2);

    [Test]
    public void Every_preset_builds_valid_cubes_with_consistent_sharing()
    {
        foreach (var preset in HexTemplates.Presets)
        {
            var mesh = Build(preset.Kind, preset.Values).Mesh;

            Assert.That(mesh.InvalidHexes(), Is.Empty, $"{preset.Name}: folded cubes {string.Join(",", mesh.InvalidHexes().Take(5))}");
            Assert.That(mesh.Hexes.Count, Is.GreaterThan(0), preset.Name);
            // every node is owned by cubes that are connected through links
            foreach (var node in mesh.Nodes)
                Assert.That(mesh.OwnersOf(node.Id), Is.Not.Empty, preset.Name);
            // the body is in one piece
            Assert.That(mesh.ComponentSizesWithout(-1).Count, Is.EqualTo(1), preset.Name);
        }
    }

    [TestCase("plate-10", 100)]
    [TestCase("cube-10", 1000)]
    public void The_big_blocks_are_in_the_library_with_the_cubes_they_name(string name, int cubes)
    {
        var preset = HexTemplates.Presets.Single(p => p.Name == name);

        var mesh = Build(preset.Kind, preset.Values).Mesh;

        Assert.That(mesh.Hexes.Count, Is.EqualTo(cubes));
        Assert.That(mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void Preset_names_are_unique_and_point_at_existing_kinds_with_valid_values()
    {
        Assert.That(HexTemplates.Presets.Select(p => p.Name).Distinct().Count(), Is.EqualTo(HexTemplates.Presets.Count));
        Assert.That(HexTemplates.Kinds.Select(k => k.Name).Distinct().Count(), Is.EqualTo(HexTemplates.Kinds.Count));
        foreach (var preset in HexTemplates.Presets)
        {
            var kind = HexTemplates.Kind(preset.Kind);
            Assert.That(preset.Values.Keys, Is.SubsetOf(kind.Parameters.Select(p => p.Key)), preset.Name);
        }
        Assert.That(HexTemplates.Presets.Count, Is.GreaterThanOrEqualTo(30));
    }

    [Test]
    public void The_round_kinds_stay_valid_whatever_the_number_of_cubes()
    {
        foreach (int n in new[] { 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 32 })
        {
            Assert.That(Build("cylinder", V(("around", n), ("along", 2))).Mesh.InvalidHexes(), Is.Empty, $"cylinder {n}");
            Assert.That(Build("pipe", V(("around", Math.Max(n, 4)), ("along", 2))).Mesh.InvalidHexes(), Is.Empty, $"pipe {n}");
            Assert.That(Build("torus", V(("around", Math.Max(n, 6)))).Mesh.InvalidHexes(), Is.Empty, $"torus {n}");
            Assert.That(Build("plate-hole", V(("around", Math.Max(n, 6)))).Mesh.InvalidHexes(), Is.Empty, $"plate {n}");
        }
        foreach (int n in new[] { 2, 3, 4, 5, 6, 7, 8, 9, 10 })
        {
            Assert.That(Build("sphere", V(("around", n))).Mesh.InvalidHexes(), Is.Empty, $"sphere {n}");
            Assert.That(Build("hemisphere", V(("around", n))).Mesh.InvalidHexes(), Is.Empty, $"hemisphere {n}");
        }
        foreach (int n in new[] { 4, 6, 8, 12, 16 })
            Assert.That(Build("hollow-sphere", V(("around", n))).Mesh.InvalidHexes(), Is.Empty, $"hollow sphere {n}");
    }

    [Test]
    public void Elliptic_and_tapered_variants_stay_valid()
    {
        Assert.That(Build("cylinder", V(("radiusX", 3), ("radiusZ", 0.5), ("topScale", 0.3))).Mesh.InvalidHexes(), Is.Empty);
        Assert.That(Build("pipe", V(("radiusX", 3), ("radiusZ", 1), ("wall", 0.4), ("topScale", 2))).Mesh.InvalidHexes(), Is.Empty);
        Assert.That(Build("sphere", V(("radiusX", 4), ("radiusY", 0.5), ("radiusZ", 2))).Mesh.InvalidHexes(), Is.Empty);
        Assert.That(Build("torus", V(("ringRadius", 5), ("tubeRadius", 0.2))).Mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void Defaults_of_every_kind_build()
    {
        foreach (var kind in HexTemplates.Kinds)
            Assert.DoesNotThrow(() => Build(kind.Name), kind.Name);
    }

    [Test]
    public void A_pipe_is_a_closed_ring_of_cells_around_an_empty_hole()
    {
        var mesh = Build("pipe", V(("around", 6), ("wallCells", 1), ("along", 2))).Mesh;

        Assert.That(mesh.Hexes.Count, Is.EqualTo((36 - 16) * 2));
        Assert.That(mesh.HexAtCell((2, 0, 2)), Is.Null);                 // the hole
        Assert.That(mesh.HexAtCell((0, 0, 0)), Is.Not.Null);
        // the ring closes: walking round it through links returns to the start
        var first = mesh.HexAtCell((0, 0, 0))!;
        var seen = new HashSet<int> { first.Id };
        var queue = new Queue<int>(new[] { first.Id });
        while (queue.Count > 0)
        {
            int h = queue.Dequeue();
            foreach (var f in HexFaces.All)
                if (mesh.Neighbor(h, f) is int o && mesh.Hex(o).Cell.J == 0 && seen.Add(o)) queue.Enqueue(o);
        }
        Assert.That(seen.Count, Is.EqualTo(20));
    }

    [Test]
    public void A_pipe_stays_hollow_in_real_space_with_the_requested_radii()
    {
        var mesh = Build("pipe", V(("around", 8), ("wallCells", 1), ("radiusX", 2), ("radiusZ", 2), ("wall", 0.5), ("height", 3))).Mesh;
        double c = 4;   // grid centre in real space for an 8-wide pipe
        var radii = mesh.Nodes.Select(n => Math.Sqrt(Math.Pow(n.Position.X - c, 2) + Math.Pow(n.Position.Z - c, 2))).ToList();

        Assert.That(radii.Min(), Is.EqualTo(1.5).Within(1e-9));          // the hole is exactly round
        Assert.That(radii.Max(), Is.InRange(2.0, 2.0 * 1.25));           // the outside is round, only the four lattice corners bulge a little
        Assert.That(mesh.Nodes.Max(n => n.Position.Y), Is.EqualTo(3).Within(1e-9));
        // away from the corners the outer surface is exactly on the circle
        var middle = mesh.Nodes.Where(n => n.Ideal.X == 0 && n.Ideal.Z is >= 6 and <= 10).ToList();
        Assert.That(middle, Is.Not.Empty);
        foreach (var n in middle) Assert.That(Math.Sqrt(Math.Pow(n.Position.X - c, 2) + Math.Pow(n.Position.Z - c, 2)), Is.EqualTo(2).Within(1e-9));
    }

    [Test]
    public void The_surface_nodes_of_a_cylinder_lie_on_the_circle_midpoints_included()
    {
        var mesh = Build("cylinder", V(("around", 8), ("radiusX", 1.5), ("radiusZ", 1.5))).Mesh;
        double c = 4;
        // the middle of a side (clear of the lattice corners): every node, corners and edge midpoints alike
        var side = mesh.Nodes.Where(n => n.Ideal.X == 0 && n.Ideal.Z is >= 6 and <= 10).ToList();

        Assert.That(side.Count, Is.GreaterThan(4));
        foreach (var n in side)
            Assert.That(Math.Sqrt(Math.Pow(n.Position.X - c, 2) + Math.Pow(n.Position.Z - c, 2)), Is.EqualTo(1.5).Within(1e-9));
        // the four corners of the lattice bulge slightly instead of folding their cubes
        Assert.That(mesh.Nodes.Max(n => Math.Sqrt(Math.Pow(n.Position.X - c, 2) + Math.Pow(n.Position.Z - c, 2))), Is.InRange(1.5, 1.5 * 1.25));
    }

    [Test]
    public void A_sphere_has_its_surface_at_the_radius_away_from_the_ridges_and_an_ellipsoid_at_its_semi_axes()
    {
        var ball = Build("sphere", V(("around", 6), ("radiusX", 2), ("radiusY", 2), ("radiusZ", 2))).Mesh;
        // the middle of a face of the lattice cube: only one coordinate on the boundary, the others in the middle two cells
        var face = ball.Nodes.Where(n => n.Ideal.X == 0 && n.Ideal.Y is >= 4 and <= 8 && n.Ideal.Z is >= 4 and <= 8).ToList();
        Assert.That(face, Is.Not.Empty);
        foreach (var n in face)
            Assert.That(Math.Sqrt(Math.Pow(n.Position.X - 3, 2) + Math.Pow(n.Position.Y - 3, 2) + Math.Pow(n.Position.Z - 3, 2)), Is.EqualTo(2).Within(0.1));      // the ridge push reaches a little into the faces

        var ellipsoid = Build("sphere", V(("around", 4), ("radiusX", 3), ("radiusY", 1), ("radiusZ", 2))).Mesh;
        Assert.That(ellipsoid.Nodes.Max(n => n.Position.X) - ellipsoid.Nodes.Min(n => n.Position.X), Is.InRange(6, 6 * 1.4));
        Assert.That(ellipsoid.Nodes.Max(n => n.Position.Y) - ellipsoid.Nodes.Min(n => n.Position.Y), Is.InRange(2, 2 * 1.4));
        Assert.That(ellipsoid.Nodes.Max(n => n.Position.Z) - ellipsoid.Nodes.Min(n => n.Position.Z), Is.InRange(4, 4 * 1.4));
        Assert.That(ellipsoid.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void A_hollow_sphere_has_no_centre_cell_and_a_dome_is_open_at_the_bottom()
    {
        var shell = Build("hollow-sphere", V(("around", 6), ("wallCells", 1))).Mesh;
        Assert.That(shell.Hexes.Count, Is.EqualTo(216 - 64));
        Assert.That(shell.HexAtCell((2, 2, 2)), Is.Null);

        var dome = Build("hemisphere", V(("around", 6), ("wallCells", 1))).Mesh;
        Assert.That(dome.Nodes.Min(n => n.Position.Y), Is.EqualTo(0).Within(1e-9));
        Assert.That(dome.HexAtCell((2, 0, 2)), Is.Null);   // hollow under the cap
        Assert.That(dome.HexAtCell((0, 0, 0)), Is.Not.Null);
    }

    [Test]
    public void The_kind_stays_the_same_when_the_parameters_change()
    {
        var small = Build("pipe", V(("around", 8), ("radiusX", 1), ("radiusZ", 1), ("wall", 0.2))).Mesh;
        var big = Build("pipe", V(("around", 8), ("radiusX", 10), ("radiusZ", 10), ("wall", 3), ("height", 20), ("along", 8))).Mesh;

        // same ring of cells in the plan view, only larger and longer
        var plan = (HexMesh m) => m.Hexes.Where(h => h.Cell.J == 0).Select(h => (h.Cell.I, h.Cell.K)).OrderBy(x => x).ToList();
        Assert.That(plan(big), Is.EqualTo(plan(small)));
        Assert.That(big.Hexes.Count, Is.EqualTo(small.Hexes.Count / 4 * 8));
        Assert.That(big.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void A_torus_closes_into_a_ring_and_its_tube_has_the_requested_radius()
    {
        var mesh = Build("torus", V(("around", 8), ("tubeCells", 2), ("ringRadius", 2), ("tubeRadius", 0.5))).Mesh;

        Assert.That(mesh.Hexes.Count, Is.EqualTo((64 - 16) * 2));
        Assert.That(mesh.Nodes.Min(n => n.Position.Y), Is.InRange(-0.25, 0));
        Assert.That(mesh.Nodes.Max(n => n.Position.Y), Is.InRange(1, 1.25));        // tube diameter 2 * 0.5, corners of the section bulge a little
        double outer = mesh.Nodes.Max(n => Math.Sqrt(Math.Pow(n.Position.X - 4, 2) + Math.Pow(n.Position.Z - 4, 2)));
        Assert.That(outer, Is.InRange(2.5, 2.5 * 1.25));
        Assert.That(mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void Profiles_keep_only_their_cells()
    {
        Assert.That(Build("l-profile", V(("armX", 4), ("armY", 4), ("thick", 1), ("depth", 1))).Mesh.Hexes.Count, Is.EqualTo(7));
        Assert.That(Build("t-profile", V(("width", 5), ("height", 4), ("thick", 1), ("depth", 1))).Mesh.Hexes.Count, Is.EqualTo(5 + 3));
        Assert.That(Build("u-profile", V(("width", 5), ("height", 4), ("thick", 1), ("depth", 1))).Mesh.Hexes.Count, Is.EqualTo(5 + 2 * 3));
        Assert.That(Build("cross", V(("arm", 2), ("thick", 1), ("depth", 1))).Mesh.Hexes.Count, Is.EqualTo(9));
        Assert.That(Build("stairs", V(("steps", 4), ("depth", 1))).Mesh.Hexes.Count, Is.EqualTo(10));
    }

    [Test]
    public void Neighbouring_cells_share_their_face_nodes_and_unrelated_ones_do_not()
    {
        var mesh = Build("l-profile", V(("armX", 3), ("armY", 3), ("thick", 1), ("depth", 1))).Mesh;
        var a = mesh.HexAtCell((0, 0, 0))!;
        var b = mesh.HexAtCell((1, 0, 0))!;

        Assert.That(mesh.Neighbor(a.Id, HexFace.XPlus), Is.EqualTo(b.Id));
        foreach (int s in HexFace.XPlus.Slots())
            Assert.That(a.NodeIds[s], Is.EqualTo(b.NodeIds[HexFace.XPlus.PartnerSlot(s)]));
        // (2,0,0) and (0,2,0) are not adjacent - no shared nodes
        var far1 = mesh.HexAtCell((2, 0, 0))!;
        var far2 = mesh.HexAtCell((0, 2, 0))!;
        Assert.That(far1.NodeIds.Intersect(far2.NodeIds), Is.Empty);
    }

    [Test]
    public void Cells_touching_only_along_an_edge_stay_separate_unless_a_link_chain_joins_them()
    {
        // two cubes meeting only at an edge, nothing between them
        var cell = (int i, int j) => new BodyCell(i, j, 0, Enumerable.Range(0, 20).Select(s => new Vec3(i + (Hex20Reference.LocalCoords[s, 0] + 1) / 2.0, j + (Hex20Reference.LocalCoords[s, 1] + 1) / 2.0, (Hex20Reference.LocalCoords[s, 2] + 1) / 2.0)).ToList());
        var editor = new HexMeshEditor();
        editor.AddBody(new BodyPlan(new[] { cell(0, 0), cell(1, 1) }));
        var a = editor.Mesh.HexAtCell((0, 0, 0))!;
        var b = editor.Mesh.HexAtCell((1, 1, 0))!;

        Assert.That(a.NodeIds.Intersect(b.NodeIds), Is.Empty);
    }

    [Test]
    public void A_body_added_to_a_non_empty_mesh_lands_free_of_it_and_is_not_linked_to_it()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        int before = editor.Mesh.Hexes.Count;

        var result = editor.AddBody(HexTemplates.Kind("block").Build(V(("countX", 2), ("countY", 1), ("countZ", 1))));

        Assert.That(result.Ok, Is.True);
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(before + 2));
        var cells = editor.Mesh.Hexes.Select(h => h.Cell.I).OrderBy(i => i).ToList();
        Assert.That(cells, Is.EqualTo(new[] { 0, 2, 3 }));
        Assert.That(editor.Mesh.Neighbor(0, HexFace.XPlus), Is.Null);
        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void Adding_a_body_is_one_undo_step()
    {
        var editor = Build("pipe");

        Assert.That(editor.CanUndo, Is.True);
        editor.Undo();
        Assert.That(editor.Mesh.Hexes, Is.Empty);
        editor.Redo();
        Assert.That(editor.Mesh.Hexes, Is.Not.Empty);
    }

    [Test]
    public void The_body_round_trips_through_a_state_snapshot()
    {
        var mesh = Build("torus").Mesh;

        var again = HexMesh.FromState(mesh.ToState());

        Assert.That(again.Hexes.Count, Is.EqualTo(mesh.Hexes.Count));
        Assert.That(again.Nodes.Count, Is.EqualTo(mesh.Nodes.Count));
        Assert.That(again.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void The_body_exports_to_the_solver_mesh()
    {
        var fem = Build("cylinder").Mesh.ToFemMesh();

        Assert.That(fem.ElementIds.Length, Is.GreaterThan(0));
    }

    [Test]
    public void The_ideal_world_maps_back_through_the_real_one_for_a_curved_body()
    {
        var mesh = Build("pipe", V(("around", 6), ("wallCells", 1), ("along", 2))).Mesh;
        var ideal = new Vec3(0.5, 0.5, 0.5);

        Assert.That(mesh.TryMapIdealToReal(ideal, out var real), Is.True);
        Assert.That(mesh.TryMapRealToIdeal(real, out var back), Is.True);
        Assert.That((back - ideal).Length, Is.LessThan(1e-6));
    }

    [Test]
    public void Bad_parameters_say_what_to_change()
    {
        var pipe = HexTemplates.Kind("pipe");

        Assert.That(() => pipe.Build(V(("wallCells", 4), ("around", 8))), Throws.ArgumentException.With.Message.Contains("порожнин"));
        Assert.That(() => pipe.Build(V(("wall", 5))), Throws.ArgumentException.With.Message.Contains("радіус"));
        Assert.That(() => pipe.Build(V(("along", 500))), Throws.ArgumentException.With.Message.Contains("outside"));
        Assert.That(() => pipe.Build(V(("nonsense", 1))), Throws.ArgumentException.With.Message.Contains("nonsense"));
        Assert.That(() => pipe.Build(V(("radiusX", double.NaN))), Throws.ArgumentException.With.Message.Contains("finite"));
        Assert.That(() => HexTemplates.Kind("nope"), Throws.ArgumentException);
    }

    [Test]
    public void Integer_parameters_are_rounded_and_too_many_cubes_are_refused()
    {
        Assert.That(Build("block", V(("countX", 2.6), ("countY", 1), ("countZ", 1))).Mesh.Hexes.Count, Is.EqualTo(3));
        Assert.That(() => HexTemplates.Kind("block").Build(V(("countX", 40), ("countY", 40), ("countZ", 40))), Throws.ArgumentException.With.Message.Contains("limit"));
    }

    [Test]
    public void An_overlapping_or_malformed_plan_is_rejected()
    {
        var positions = Enumerable.Range(0, 20).Select(_ => Vec3.Zero).ToList();
        Assert.That(() => new BodyPlan(new[] { new BodyCell(0, 0, 0, positions), new BodyCell(0, 0, 0, positions) }), Throws.ArgumentException);
        Assert.That(() => new BodyPlan(new[] { new BodyCell(0, 0, 0, positions.Take(5).ToList()) }), Throws.ArgumentException);
        Assert.That(() => new BodyPlan(Array.Empty<BodyCell>()), Throws.ArgumentException);
    }

    private static HexMeshEditor AddTemplate(HexMeshEditor editor, string kind, IReadOnlyDictionary<string, double>? values = null)
    {
        var result = editor.AddTemplateBody(HexTemplates.Kind(kind).Build(values));
        Assert.That(result.Ok, Is.True, result.Error);
        return editor;
    }

    private static (Vec3 Min, Vec3 Max) RealBounds(HexMesh mesh) => (
        new Vec3(mesh.Nodes.Min(n => n.Position.X), mesh.Nodes.Min(n => n.Position.Y), mesh.Nodes.Min(n => n.Position.Z)),
        new Vec3(mesh.Nodes.Max(n => n.Position.X), mesh.Nodes.Max(n => n.Position.Y), mesh.Nodes.Max(n => n.Position.Z)));

    [Test]
    public void A_template_body_is_centred_at_the_origin_in_the_real_world_and_on_the_lattice()
    {
        foreach (var preset in HexTemplates.Presets.Take(12))
        {
            var mesh = AddTemplate(new HexMeshEditor(), preset.Kind, preset.Values).Mesh;

            var (min, max) = RealBounds(mesh);
            Assert.That((min.X + max.X) / 2, Is.EqualTo(0).Within(1e-9), preset.Name);
            Assert.That((min.Y + max.Y) / 2, Is.EqualTo(0).Within(1e-9), preset.Name);
            Assert.That((min.Z + max.Z) / 2, Is.EqualTo(0).Within(1e-9), preset.Name);
            // the cells are the nearest whole cells to the middle: at most half a cell off
            foreach (var axis in new Func<Hex20, int>[] { h => h.Cell.I, h => h.Cell.J, h => h.Cell.K })
                Assert.That((mesh.Hexes.Min(axis) + mesh.Hexes.Max(axis) + 1) / 2.0, Is.EqualTo(0).Within(0.5), preset.Name);
        }
    }

    [Test]
    public void Adding_a_second_template_replaces_the_first_and_centres_the_new_one()
    {
        var editor = AddTemplate(new HexMeshEditor(), "pipe");
        int pipeCubes = editor.Mesh.Hexes.Count;

        AddTemplate(editor, "block", V(("countX", 3), ("countY", 2), ("countZ", 1)));

        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(6));
        Assert.That(editor.Mesh.Hexes.Count, Is.Not.EqualTo(pipeCubes));
        Assert.That(editor.Mesh.Hexes.All(h => h.IsTemplate), Is.True);
        var (min, max) = RealBounds(editor.Mesh);
        Assert.That((min.X + max.X) / 2, Is.EqualTo(0).Within(1e-9));
        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
        Assert.That(editor.Mesh.ComponentSizesWithout(-1).Count, Is.EqualTo(1));
    }

    [Test]
    public void Replacing_a_template_is_one_undo_step_that_brings_the_old_one_back()
    {
        var editor = AddTemplate(new HexMeshEditor(), "pipe");
        int pipeCubes = editor.Mesh.Hexes.Count;
        AddTemplate(editor, "block", V(("countX", 2), ("countY", 1), ("countZ", 1)));

        editor.Undo();

        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(pipeCubes));
        Assert.That(editor.Mesh.Hexes.All(h => h.IsTemplate), Is.True);      // the mark survives the snapshot
    }

    [Test]
    public void A_template_leaves_hand_made_cubes_alone_and_goes_beside_them_when_the_centre_is_taken()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();

        AddTemplate(editor, "block", V(("countX", 2), ("countY", 2), ("countZ", 2)));
        AddTemplate(editor, "block", V(("countX", 1), ("countY", 1), ("countZ", 1)));

        Assert.That(editor.Mesh.Hexes.Count(h => !h.IsTemplate), Is.EqualTo(1));
        Assert.That(editor.Mesh.Hexes.Count(h => h.IsTemplate), Is.EqualTo(1));
        Assert.That(editor.Mesh.HexAtCell((0, 0, 0))!.IsTemplate, Is.False);
    }
}
