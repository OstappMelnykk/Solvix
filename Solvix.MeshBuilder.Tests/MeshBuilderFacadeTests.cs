using Solvix.Contracts.Facades;

namespace Solvix.MeshBuilder.Tests;

public class MeshBuilderFacadeTests
{
    private static IMeshBuilderFacade NewFacade() => new MeshBuilderFacade(new MeshEditorSessions());

    // A(0,0) B(1,0) C(1,1) D(0,1) in session 1; D is linked to A only.
    private static IMeshBuilderFacade Square()
    {
        var facade = NewFacade();
        Assert.That(facade.AddFirstHex(1).Ok, Is.True);
        Assert.That(facade.AddHexOnFace(1, 0, "XPlus").Ok, Is.True);
        Assert.That(facade.AddHexOnFace(1, 1, "YPlus").Ok, Is.True);
        Assert.That(facade.AddHexOnFace(1, 0, "YPlus").Ok, Is.True);
        return facade;
    }

    [Test]
    public void A_new_session_starts_empty()
    {
        var state = NewFacade().GetState(7);

        Assert.That(state.Hexes, Is.Empty);
        Assert.That(state.Nodes, Is.Empty);
        Assert.That(state.CanUndo, Is.False);
    }

    [Test]
    public void The_first_cube_has_20_nodes_with_ideal_coordinates()
    {
        var facade = NewFacade();

        var result = facade.AddFirstHex(1);

        Assert.That(result.Ok, Is.True);
        Assert.That(result.State.Nodes, Has.Count.EqualTo(20));
        Assert.That(result.State.Hexes.Single().NodeIds, Has.Count.EqualTo(20));
        Assert.That(result.State.Nodes.Max(n => n.IdealX), Is.EqualTo(2));
        Assert.That(result.State.Faces, Has.Count.EqualTo(6));
        Assert.That(result.State.CanUndo, Is.True);
    }

    [Test]
    public void Sessions_are_isolated_from_each_other()
    {
        var facade = NewFacade();
        facade.AddFirstHex(1);

        Assert.That(facade.GetState(2).Hexes, Is.Empty);
        Assert.That(facade.GetState(1).Hexes, Has.Count.EqualTo(1));
    }

    [Test]
    public void The_square_reports_one_candidate_pair_and_three_links()
    {
        var state = Square().GetState(1);

        Assert.That(state.Links, Has.Count.EqualTo(3));
        var candidates = state.Faces.Where(f => f.Status == "Candidate").ToList();
        Assert.That(candidates, Has.Count.EqualTo(2));   // D:XPlus and C:XMinus
        Assert.That(candidates.All(f => f.Coincident == true), Is.True);
    }

    [Test]
    public void Linking_two_faces_through_the_api_merges_nodes_and_clears_the_candidates()
    {
        var facade = Square();
        int before = facade.GetState(1).Nodes.Count;

        var result = facade.LinkFaces(1, 3, "XPlus", 2, "XMinus", adaptSecond: false);

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(result.State.Nodes.Count, Is.LessThan(before));
        Assert.That(result.State.Faces.Count(f => f.Status == "Candidate"), Is.EqualTo(0));
        Assert.That(result.State.Links, Has.Count.EqualTo(4));
    }

    [Test]
    public void A_refused_command_reports_why_and_returns_the_unchanged_state()
    {
        var facade = Square();
        int version = facade.GetState(1).Version;

        var result = facade.LinkFaces(1, 0, "XPlus", 2, "XMinus", adaptSecond: false);

        Assert.That(result.Ok, Is.False);
        Assert.That(result.Error, Does.Contain("not adjacent"));
        Assert.That(result.State.Version, Is.EqualTo(version));
    }

    [Test]
    public void Unknown_face_names_and_ids_are_rejected_not_thrown()
    {
        var facade = Square();

        Assert.That(facade.AddHexOnFace(1, 0, "Up").Ok, Is.False);
        Assert.That(facade.AddHexOnFace(1, 0, "42").Ok, Is.False);
        Assert.That(facade.LinkFaces(1, 3, "Nope", 2, "XMinus", false).Error, Does.Contain("Unknown face"));
        Assert.That(facade.LinkFaces(1, 3, "XPlus", 2, "Nope", false).Error, Does.Contain("Unknown face"));
        Assert.That(facade.AddHexOnFace(1, 999, "XPlus").Error, Does.Contain("Unknown hex"));
        Assert.That(facade.MoveNode(1, 999, new MeshPointDto(0, 0, 0), true).Ok, Is.False);
    }

    [Test]
    public void Moving_a_shared_node_moves_it_once_and_undo_puts_it_back()
    {
        var facade = Square();
        var state = facade.GetState(1);
        var a = state.Hexes.Single(h => h.Id == 0);
        int shared = a.NodeIds[1];
        var original = state.Nodes.Single(n => n.Id == shared);

        var moved = facade.MoveNode(1, shared, new MeshPointDto(original.X, original.Y - 0.3, original.Z), carryEdgeMidpoints: true);

        Assert.That(moved.Ok, Is.True);
        Assert.That(moved.State.Nodes.Single(n => n.Id == shared).Y, Is.EqualTo(original.Y - 0.3).Within(1e-12));
        Assert.That(moved.State.Nodes.Count, Is.EqualTo(state.Nodes.Count));

        var undone = facade.Undo(1);
        Assert.That(undone.Ok, Is.True);
        Assert.That(undone.State.Nodes.Single(n => n.Id == shared).Y, Is.EqualTo(original.Y));
        Assert.That(facade.Redo(1).State.Nodes.Single(n => n.Id == shared).Y, Is.EqualTo(original.Y - 0.3).Within(1e-12));
    }

    [Test]
    public void Undo_and_redo_with_nothing_to_do_say_so()
    {
        var facade = NewFacade();

        Assert.That(facade.Undo(1).Ok, Is.False);
        Assert.That(facade.Redo(1).Error, Does.Contain("Nothing to redo"));
    }

    [Test]
    public void Mapping_works_both_ways_and_reports_points_outside_the_body()
    {
        var facade = Square();
        var ideal = new MeshPointDto(1.3, 0.4, 0.6);

        var real = facade.MapIdealToReal(1, ideal);
        Assert.That(real.Found, Is.True);
        var back = facade.MapRealToIdeal(1, real.Point!);

        Assert.That(back.Found, Is.True);
        Assert.That(back.Point!.X, Is.EqualTo(ideal.X).Within(1e-7));
        Assert.That(back.Point.Y, Is.EqualTo(ideal.Y).Within(1e-7));
        Assert.That(facade.MapIdealToReal(1, new MeshPointDto(9, 9, 9)).Found, Is.False);
        Assert.That(facade.MapRealToIdeal(1, new MeshPointDto(9, 9, 9)).Found, Is.False);
    }

    [Test]
    public void Concurrent_commands_on_one_session_do_not_corrupt_it()
    {
        var facade = NewFacade();
        facade.AddFirstHex(1);
        var firstNode = facade.GetState(1).Nodes[0].Id;

        Parallel.For(0, 200, i => facade.MoveNode(1, firstNode, new MeshPointDto(i * 0.001, 0, 0), false));

        var state = facade.GetState(1);
        Assert.That(state.Nodes, Has.Count.EqualTo(20));
        Assert.That(state.Version, Is.EqualTo(201));
    }

    [Test]
    public void Linking_two_cubes_by_id_finds_the_shared_face()
    {
        var facade = Square();

        var result = facade.LinkHexes(1, 3, 2, adaptSecond: false);

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(result.State.Links, Has.Count.EqualTo(4));
        Assert.That(result.State.Faces.Count(f => f.Status == "Candidate"), Is.EqualTo(0));
        Assert.That(facade.LinkHexes(1, 0, 2, false).Error, Does.Contain("not across a face"));
    }

    [Test]
    public void Removing_a_cube_through_the_facade_and_the_refusal_of_a_bridge()
    {
        var facade = Square();   // chain D-A-B-C

        var bridge = facade.RemoveHex(1, 0);
        Assert.That(bridge.Ok, Is.False);
        Assert.That(bridge.Error, Does.Contain("split the body"));
        Assert.That(bridge.State.Hexes, Has.Count.EqualTo(4));

        var leaf = facade.RemoveHex(1, 3);
        Assert.That(leaf.Ok, Is.True, leaf.Error);
        Assert.That(leaf.State.Hexes, Has.Count.EqualTo(3));
        Assert.That(leaf.State.Hexes.Any(h => h.Id == 3), Is.False);
        Assert.That(facade.RemoveHex(1, 99).Error, Does.Contain("Unknown hex"));
    }

    [Test]
    public void Dropping_a_session_forgets_its_mesh_and_history_but_not_other_sessions()
    {
        var facade = NewFacade();
        facade.AddFirstHex(1);
        facade.AddFirstHex(2);
        Assert.That(facade.GetState(1).CanUndo, Is.True);

        facade.DropSession(1);

        var fresh = facade.GetState(1);
        Assert.That(fresh.Hexes, Is.Empty);
        Assert.That(fresh.CanUndo, Is.False);
        Assert.That(fresh.Version, Is.EqualTo(0));
        Assert.That(facade.GetState(2).Hexes, Has.Count.EqualTo(1));
    }

    [Test]
    public void Dropping_an_unknown_session_is_harmless()
    {
        var facade = NewFacade();

        Assert.DoesNotThrow(() => facade.DropSession(99));
        Assert.DoesNotThrow(() => facade.DropSession(99));
    }

    // ---- the cube constructor ------------------------------------------------------------

    private static MeshShapeDto Beam(IMeshBuilderFacade facade) => facade.BuildShape(new MeshShapeParametersDto(3, 1, 1, 1, 0, 0));

    [Test]
    public void The_library_offers_named_presets_with_parameters()
    {
        var presets = NewFacade().ShapePresets();

        Assert.That(presets.Select(p => p.Name), Does.Contain("unit").And.Contain("beam").And.Contain("tapered"));
        var beam = presets.Single(p => p.Name == "beam");
        Assert.That(beam.Parameters.Length, Is.EqualTo(3));
        Assert.That(presets.Select(p => p.Name).Distinct().Count(), Is.EqualTo(presets.Count));
    }

    [Test]
    public void Building_a_parametric_block_gives_twenty_positions_in_slot_order()
    {
        var shape = NewFacade().BuildShape(new MeshShapeParametersDto(2, 3, 4, 1, 0, 0));

        Assert.That(shape.Positions, Has.Count.EqualTo(20));
        Assert.That(shape.Positions[0], Is.EqualTo(new MeshPointDto(0, 0, 0)));
        Assert.That(shape.Positions[6], Is.EqualTo(new MeshPointDto(2, 3, 4)));
        Assert.That(shape.Positions[8], Is.EqualTo(new MeshPointDto(1, 0, 0)));
    }

    [Test]
    public void Taper_and_shear_move_the_top_and_keep_sides_straight()
    {
        var shape = NewFacade().BuildShape(new MeshShapeParametersDto(2, 2, 2, 0.5, 1, 0));

        Assert.That(shape.Positions[6].X, Is.EqualTo(1 + 0.5 * 1 + 2).Within(1e-9));    // top corner: centre 1 + half-width 1*0.5, plus shear 1*2
        Assert.That(shape.Positions[2].Y, Is.EqualTo(2).Within(1e-9));                  // the height is not changed by taper or shear
        Assert.That(shape.Positions[1], Is.EqualTo(new MeshPointDto(2, 0, 0)));         // the bottom is not scaled
        // the side edge (-,*,-): bottom corner slot 0, top corner slot 3, midpoint slot 11 - all on one straight line
        var bottom = shape.Positions[0]; var top = shape.Positions[3]; var middle = shape.Positions[11];
        Assert.That(middle.X, Is.EqualTo((bottom.X + top.X) / 2).Within(1e-9));
        Assert.That(middle.Z, Is.EqualTo((bottom.Z + top.Z) / 2).Within(1e-9));
    }

    [Test]
    public void Checking_a_shape_tells_valid_from_folded_and_malformed()
    {
        var facade = NewFacade();
        var unit = facade.BuildShape(new MeshShapeParametersDto(1, 1, 1, 1, 0, 0));
        var folded = new MeshShapeDto(unit.Positions.Select((p, i) => i == 0 ? new MeshPointDto(1.6, 1.6, 1.6) : p).ToList());

        Assert.That(facade.CheckShape(unit).Valid, Is.True);
        Assert.That(facade.CheckShape(unit).MinDeterminant, Is.EqualTo(0.125).Within(1e-9));
        Assert.That(facade.CheckShape(folded).Valid, Is.False);
        var malformed = facade.CheckShape(new MeshShapeDto(new[] { new MeshPointDto(0, 0, 0) }));
        Assert.That(malformed.Valid, Is.False);
        Assert.That(malformed.Error, Does.Contain("20"));
        Assert.That(facade.CheckShape(new MeshShapeDto(unit.Positions.Select((p, i) => i == 3 ? new MeshPointDto(double.NaN, 0, 0) : p).ToList())).Error, Does.Contain("finite"));
    }

    [Test]
    public void A_designed_cube_starts_and_extends_the_body_through_the_facade()
    {
        var facade = NewFacade();
        var first = facade.AddFirstHex(1, Beam(facade));
        Assert.That(first.Ok, Is.True, first.Error);
        Assert.That(first.State.Nodes.Max(n => n.X), Is.EqualTo(3).Within(1e-9));

        var second = facade.AddHexOnFace(1, 0, "XPlus", Beam(facade));

        Assert.That(second.Ok, Is.True, second.Error);
        Assert.That(second.State.Hexes, Has.Count.EqualTo(2));
        Assert.That(second.State.Nodes.Max(n => n.X), Is.EqualTo(6).Within(1e-9));
        Assert.That(second.State.InvalidHexes, Is.Empty);
    }

    [Test]
    public void A_malformed_shape_is_a_refusal_with_the_state_unchanged_not_an_exception()
    {
        var facade = NewFacade();
        facade.AddFirstHex(1);
        int version = facade.GetState(1).Version;

        var result = facade.AddHexOnFace(1, 0, "XPlus", new MeshShapeDto(new[] { new MeshPointDto(0, 0, 0) }));

        Assert.That(result.Ok, Is.False);
        Assert.That(result.Error, Does.Contain("20"));
        Assert.That(result.State.Version, Is.EqualTo(version));
        Assert.That(facade.AddFirstHex(2, new MeshShapeDto(null!)).Ok, Is.False);
    }

    [Test]
    public void A_designed_attach_is_undoable()
    {
        var facade = NewFacade();
        facade.AddFirstHex(1);
        facade.AddHexOnFace(1, 0, "YPlus", Beam(facade));

        var undone = facade.Undo(1);

        Assert.That(undone.State.Hexes, Has.Count.EqualTo(1));
        Assert.That(facade.Redo(1).State.Hexes, Has.Count.EqualTo(2));
    }
}
