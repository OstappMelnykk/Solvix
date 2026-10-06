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
        Assert.That(facade.LinkHexes(1, 0, 2, false).Error, Does.Contain("not adjacent"));
    }
}
