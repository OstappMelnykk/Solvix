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
        foreach (int n in new[] { 4, 6, 8, 10, 12, 16, 24, 32, 64 })
        {
            Assert.That(Build("pipe", V(("sectors", n), ("along", 2), ("wallCells", 2))).Mesh.InvalidHexes(), Is.Empty, $"pipe {n}");
            Assert.That(Build("torus", V(("ringSectors", n), ("tubeSectors", 4 + n % 8 / 2 * 2))).Mesh.InvalidHexes(), Is.Empty, $"torus {n}");
        }
        foreach (int n in new[] { 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 32 })
            Assert.That(Build("cylinder", V(("around", n), ("along", 2))).Mesh.InvalidHexes(), Is.Empty, $"cylinder {n}");
        foreach (int n in new[] { 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 })
        {
            Assert.That(Build("sphere", V(("around", n))).Mesh.InvalidHexes(), Is.Empty, $"sphere {n}");
            Assert.That(Build("hemisphere", V(("around", n))).Mesh.InvalidHexes(), Is.Empty, $"hemisphere {n}");
        }
        foreach (int n in new[] { 4, 6, 8, 12, 16, 24 })
            Assert.That(Build("hollow-sphere", V(("around", n))).Mesh.InvalidHexes(), Is.Empty, $"hollow sphere {n}");
    }

    [Test]
    public void Elliptic_and_tapered_variants_stay_valid()
    {
        Assert.That(Build("cylinder", V(("radiusX", 3), ("radiusZ", 0.5), ("topScale", 0.3))).Mesh.InvalidHexes(), Is.Empty);
        Assert.That(Build("pipe", V(("radiusX", 3), ("radiusZ", 1), ("wall", 0.4), ("topScale", 2))).Mesh.InvalidHexes(), Is.Empty);
        Assert.That(Build("pipe", V(("sectors", 4), ("radiusX", 3), ("radiusZ", 0.5), ("wall", 0.2))).Mesh.InvalidHexes(), Is.Empty);
        Assert.That(Build("sphere", V(("radiusX", 4), ("radiusY", 0.5), ("radiusZ", 2))).Mesh.InvalidHexes(), Is.Empty);
        Assert.That(Build("torus", V(("ringRadius", 5), ("tubeRadius", 0.2), ("wall", 0.05))).Mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void Defaults_of_every_kind_build()
    {
        foreach (var kind in HexTemplates.Kinds)
            Assert.DoesNotThrow(() => Build(kind.Name), kind.Name);
    }

    [Test]
    public void A_pipe_is_a_straight_row_of_cells_in_the_ideal_world_closed_by_a_link()
    {
        var mesh = Build("pipe", V(("sectors", 6), ("wallCells", 1), ("along", 2))).Mesh;

        Assert.That(mesh.Hexes.Count, Is.EqualTo(12));
        Assert.That(mesh.Hexes.Select(h => h.Cell.I).Distinct().OrderBy(i => i), Is.EqualTo(new[] { 0, 1, 2, 3, 4, 5 }));   // a row
        var first = mesh.HexAtCell((0, 0, 0))!;
        var last = mesh.HexAtCell((5, 0, 0))!;
        Assert.That(mesh.Neighbor(last.Id, HexFace.XPlus), Is.EqualTo(first.Id));          // the closing link
        Assert.That(mesh.Neighbor(first.Id, HexFace.XMinus), Is.EqualTo(last.Id));
        foreach (int s in HexFace.XPlus.Slots())
            Assert.That(last.NodeIds[s], Is.EqualTo(first.NodeIds[HexFace.XPlus.PartnerSlot(s)]));   // and they share the seam nodes
        // walking round through links returns to the start after exactly 6 steps
        int current = first.Id, steps = 0;
        do { current = mesh.Neighbor(current, HexFace.XPlus)!.Value; steps++; } while (current != first.Id && steps < 20);
        Assert.That(steps, Is.EqualTo(6));
    }

    [Test]
    public void Removing_one_sector_opens_the_ring_but_leaves_the_body_whole()
    {
        var editor = Build("pipe", V(("sectors", 4), ("along", 1)));

        var result = editor.RemoveHex(editor.Mesh.HexAtCell((1, 0, 0))!.Id);

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(editor.Mesh.Hexes.Count, Is.EqualTo(3));
        Assert.That(editor.Mesh.ComponentSizesWithout(-1), Has.Count.EqualTo(1));
    }

    [Test]
    public void A_pipe_has_all_its_nodes_exactly_on_the_two_circles()
    {
        var mesh = Build("pipe", V(("sectors", 4), ("wallCells", 1), ("radiusX", 2), ("radiusZ", 2), ("wall", 0.5), ("height", 3))).Mesh;
        var radii = mesh.Nodes.Select(n => Math.Sqrt(Math.Pow(n.Position.X - 2, 2) + Math.Pow(n.Position.Z - 2, 2))).ToList();

        // the corners and the mid-nodes of the arcs are on the inner or outer circle; mid-nodes of the radial edges halfway between
        Assert.That(radii.All(r => Math.Abs(r - 2) < 1e-9 || Math.Abs(r - 1.75) < 1e-9 || Math.Abs(r - 1.5) < 1e-9), Is.True);
        Assert.That(radii.Min(), Is.EqualTo(1.5).Within(1e-9));
        Assert.That(radii.Max(), Is.EqualTo(2).Within(1e-9));
        Assert.That(mesh.Nodes.Max(n => n.Position.Y), Is.EqualTo(3).Within(1e-9));
        Assert.That(mesh.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void A_quarter_sector_deviates_from_the_circle_by_about_one_percent_and_an_eighth_by_far_less()
    {
        double Deviation(int sectors)
        {
            var mesh = Build("pipe", V(("sectors", sectors), ("along", 1), ("radiusX", 1), ("radiusZ", 1), ("wall", 0.5))).Mesh;
            var hex = mesh.HexAtCell((0, 0, 0))!;
            double worst = 0;
            for (double a = -1; a <= 1; a += 0.05)
            {
                // the outer face of the sector: gamma = +1, middle of the height
                var p = hex.Map(new Vec3(a, 0, 1));
                double r = Math.Sqrt(Math.Pow(p.X - 1, 2) + Math.Pow(p.Z - 1, 2));
                worst = Math.Max(worst, Math.Abs(r - 1));
            }
            return worst;
        }

        Assert.That(Deviation(4), Is.InRange(0.004, 0.015));
        Assert.That(Deviation(16), Is.LessThan(Deviation(4) / 50));
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
            Assert.That(Math.Sqrt(Math.Pow(n.Position.X - 3, 2) + Math.Pow(n.Position.Y - 3, 2) + Math.Pow(n.Position.Z - 3, 2)), Is.EqualTo(2).Within(1e-9));

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
        var small = Build("pipe", V(("sectors", 8), ("radiusX", 1), ("radiusZ", 1), ("wall", 0.2))).Mesh;
        var big = Build("pipe", V(("sectors", 8), ("radiusX", 10), ("radiusZ", 10), ("wall", 3), ("height", 20), ("along", 8))).Mesh;

        // the same ring of cells in the ideal row, only larger and longer
        var row = (HexMesh m) => m.Hexes.Where(h => h.Cell.J == 0).Select(h => (h.Cell.I, h.Cell.K)).OrderBy(x => x).ToList();
        Assert.That(row(big), Is.EqualTo(row(small)));
        Assert.That(big.Hexes.Count, Is.EqualTo(small.Hexes.Count / 4 * 8));
        Assert.That(big.InvalidHexes(), Is.Empty);
    }

    [Test]
    public void A_torus_closes_both_ways_and_all_its_nodes_lie_on_the_two_tube_circles()
    {
        var mesh = Build("torus", V(("ringSectors", 8), ("tubeSectors", 4), ("wallCells", 1), ("ringRadius", 2), ("tubeRadius", 0.5), ("wall", 0.2))).Mesh;

        Assert.That(mesh.Hexes.Count, Is.EqualTo(32));
        foreach (var hex in mesh.Hexes)
            foreach (var face in new[] { HexFace.XPlus, HexFace.XMinus, HexFace.YPlus, HexFace.YMinus })
                Assert.That(mesh.Neighbor(hex.Id, face), Is.Not.Null, $"{hex.Cell} {face}");     // every cube has its four ring neighbours
        foreach (var n in mesh.Nodes)
        {
            double fromAxis = Math.Sqrt(Math.Pow(n.Position.X - 2.5, 2) + Math.Pow(n.Position.Z - 2.5, 2));
            double r = Math.Sqrt(Math.Pow(fromAxis - 2, 2) + Math.Pow(n.Position.Y - 0.5, 2));
            Assert.That(Math.Abs(r - 0.5) < 1e-9 || Math.Abs(r - 0.4) < 1e-9 || Math.Abs(r - 0.3) < 1e-9, Is.True, $"radius {r}");
        }
        Assert.That(mesh.InvalidHexes(), Is.Empty);
        Assert.That(mesh.ToFemMesh().ElementIds.Length, Is.EqualTo(32));
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
    public void The_ideal_world_maps_back_through_the_real_one_for_a_curved_body_also_across_the_seam()
    {
        var mesh = Build("pipe", V(("sectors", 6), ("wallCells", 1), ("along", 2))).Mesh;

        foreach (var ideal in new[] { new Vec3(0.5, 0.5, 0.5), new Vec3(5.5, 1.5, 0.5), new Vec3(6, 0.5, 0.5), new Vec3(0, 0.5, 0.5) })
        {
            Assert.That(mesh.TryMapIdealToReal(ideal, out var real), Is.True, $"{ideal}");
            Assert.That(mesh.TryMapRealToIdeal(real, out var back), Is.True, $"{ideal}");
            Assert.That((back - ideal).Length, Is.LessThan(1e-6).Or.EqualTo(6).Within(1e-6), $"{ideal}");   // the seam is one place: 6 and 0 are the same point
        }
        // the two ends of the row are the same real point
        mesh.TryMapIdealToReal(new Vec3(6, 0.5, 0.5), out var end);
        mesh.TryMapIdealToReal(new Vec3(0, 0.5, 0.5), out var start);
        Assert.That((end - start).Length, Is.LessThan(1e-9));
    }

    [Test]
    public void Bad_parameters_say_what_to_change()
    {
        var pipe = HexTemplates.Kind("pipe");

        Assert.That(() => pipe.Build(V(("sectors", 7))), Throws.ArgumentException.With.Message.Contains("парною"));
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

    [Test]
    public void A_closed_axis_needs_at_least_three_cubes()
    {
        var cell = (int i) => new BodyCell(i, 0, 0, Enumerable.Range(0, 20).Select(_ => Vec3.Zero).ToList());

        Assert.That(() => new BodyPlan(new[] { cell(0), cell(1) }, wrapI: true), Throws.ArgumentException.With.Message.Contains("at least 3"));
        Assert.DoesNotThrow(() => new BodyPlan(new[] { cell(0), cell(1), cell(2) }, wrapI: true));
    }

    [Test]
    public void The_seam_link_survives_a_snapshot_and_unlinking_it_splits_the_seam_nodes()
    {
        var editor = Build("pipe", V(("sectors", 4), ("along", 1)));
        var again = HexMesh.FromState(editor.Mesh.ToState());
        var first = again.HexAtCell((0, 0, 0))!;
        var last = again.HexAtCell((3, 0, 0))!;
        Assert.That(again.Neighbor(last.Id, HexFace.XPlus), Is.EqualTo(first.Id));
        int nodesBefore = again.Nodes.Count;

        again.Unlink(last.Id, HexFace.XPlus);

        Assert.That(again.Nodes.Count, Is.EqualTo(nodesBefore + 8));                                // the 8 seam nodes are doubled
        Assert.That(again.Neighbor(first.Id, HexFace.XMinus), Is.Null);
        Assert.That(first.NodeIds.Intersect(last.NodeIds), Is.Empty);
    }

    [Test]
    public void The_solver_export_shares_the_seam_nodes()
    {
        var fem = Build("pipe", V(("sectors", 4), ("along", 1), ("wallCells", 1))).Mesh.ToFemMesh();

        // 4 cubes in a closed ring share their radial faces: 4 * 20 slots minus the 4 * 8 shared ones
        Assert.That(fem.NodeCount, Is.EqualTo(4 * 20 - 4 * 8));
    }
}
