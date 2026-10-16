using Solvix.Contracts.Facades;
using Solvix.FemMesh;
using Solvix.FemMesh.Local;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>The local refinement through the solver's front door, the way the app uses it: refine, point at faces and elements of the refined mesh, solve.</summary>
public class LocalRefinementFacadeTests
{
    private const int Session = 1;

    private static RefinementStepDto Cube(int cube, int n = 2, int depth = 0) => new(new[] { LocalRefinement.RootKey(cube) }, n, n, n, depth);

    private static ElementFaceRefDto Ref(SolverMeshDto mesh, int element, int face) => new(mesh.Keys[element], face);

    private static IEnumerable<(int Element, int Face)> Pairs(IReadOnlyList<int> flat)
    {
        for (int i = 0; i < flat.Count; i += 2) yield return (flat[i], flat[i + 1]);
    }

    // the surface faces of the mesh that lie on a side of one cube, found from the real positions of their nodes
    private static List<(int Element, int Face)> SurfaceOnPlaneX(SolverMeshDto mesh, double x, int face)
    {
        return Pairs(mesh.SurfaceFaces).Where(f => f.Face == face && ElementLocalCorners(mesh, f.Element, f.Face).All(p => Math.Abs(p - x) < 1e-9)).ToList();
    }

    private static IEnumerable<double> ElementLocalCorners(SolverMeshDto mesh, int element, int face)
    {
        foreach (int slot in ElementLocal.FaceNodes[face].Where(n => n < 8)) yield return mesh.Positions[3 * mesh.Connectivity[20 * element + slot]];
    }

    [Test]
    public void Refining_a_cube_makes_a_mesh_of_flat_elements_each_with_a_key_of_its_own()
    {
        var facade = NewFacade();
        var coarse = Export(Bar(4));

        var setup = facade.AddLocalRefinement(Session, coarse, Cube(1));
        var mesh = facade.GetMesh(Session, coarse);

        Assert.That(setup.Refinements, Has.Count.EqualTo(1));
        Assert.That(setup.Divisions, Is.EqualTo(new[] { 1, 1, 1 }));
        Assert.That(mesh.Rule, Does.Contain("local"));
        Assert.That(mesh.ElementCount, Is.GreaterThan(4 + 8 - 1));
        Assert.That(mesh.Keys.Distinct().Count(), Is.EqualTo(mesh.ElementCount));
        Assert.That(mesh.Positions, Has.Count.EqualTo(3 * mesh.NodeCount));
        Assert.That(mesh.Connectivity, Has.Count.EqualTo(20 * mesh.ElementCount));
        Assert.That(mesh.HexIds.Distinct().OrderBy(h => h), Is.EqualTo(coarse.ElementIds.OrderBy(h => h)));
        Assert.That(mesh.Materials.Distinct(), Is.EqualTo(new[] { "steel" }));
    }

    [Test]
    public void A_step_that_cannot_be_done_is_refused_and_changes_nothing()
    {
        var facade = NewFacade();
        var coarse = Export(Bar(2));
        facade.AddLocalRefinement(Session, coarse, Cube(0));
        int version = facade.GetSetup(Session).Version;

        Assert.Throws<ArgumentException>(() => facade.AddLocalRefinement(Session, coarse, new RefinementStepDto(Array.Empty<string>(), 2, 2, 2)));
        Assert.Throws<ArgumentException>(() => facade.AddLocalRefinement(Session, coarse, Cube(1, 1)), "n = 1 cuts nothing");
        Assert.Throws<ArgumentException>(() => facade.AddLocalRefinement(Session, coarse, Cube(1, 99)));
        Assert.Throws<ArgumentException>(() => facade.AddLocalRefinement(Session, coarse, Cube(1, 2, 5)), "the zone is 0, 1 or 2");
        Assert.Throws<ArgumentException>(() => facade.AddLocalRefinement(Session, coarse, new RefinementStepDto(new[] { "nothing like this" }, 2, 2, 2)));
        Assert.Throws<ArgumentException>(() => facade.AddLocalRefinement(Session, Export(new Solvix.Mesh.HexMeshEditor()), Cube(0)));

        Assert.That(facade.GetSetup(Session).Version, Is.EqualTo(version));
        Assert.That(facade.GetSetup(Session).Refinements, Has.Count.EqualTo(1));
    }

    [Test]
    public void The_even_cut_and_the_refinement_are_two_rules_for_one_mesh_and_the_last_one_chosen_wins_and_can_be_undone()
    {
        var facade = NewFacade();
        var coarse = Export(Bar(3));
        facade.SetDivisions(Session, 2, 2, 2);

        facade.AddLocalRefinement(Session, coarse, Cube(1));
        var local = facade.GetSetup(Session);
        facade.SetDivisions(Session, 3, 1, 1);
        var even = facade.GetSetup(Session);
        facade.UndoSetup(Session);
        var undone = facade.GetSetup(Session);

        Assert.That(local.Divisions, Is.EqualTo(new[] { 1, 1, 1 }));
        Assert.That(local.Refinements, Is.Not.Null);
        Assert.That(even.Divisions, Is.EqualTo(new[] { 3, 1, 1 }));
        Assert.That(even.Refinements, Is.Null, "choosing the even cut drops the refinement");
        Assert.That(undone.Refinements, Has.Count.EqualTo(1), "undone, the refinement is back");
        Assert.That(facade.GetMesh(Session, coarse).Rule, Does.Contain("local"));
        facade.ClearLocalRefinement(Session);
        Assert.That(facade.GetSetup(Session).Refinements, Is.Null);
    }

    [Test]
    public void A_face_pointed_at_on_the_refined_mesh_is_clamped_and_only_that_face()
    {
        var facade = NewFacade();
        var coarse = Export(Bar(3));
        facade.AddLocalRefinement(Session, coarse, Cube(1, 3));
        var mesh = facade.GetMesh(Session, coarse);
        // the faces of the refined cube's far side: 9 small faces where there was one
        Assert.That(SurfaceOnPlaneX(mesh, 2.0, 5), Is.Empty, "x = 2 is the side shared by cube 1 and cube 2: inside the body, not on its surface");
        Assert.That(SurfaceOnPlaneX(mesh, 3.0, 5), Has.Count.EqualTo(1), "the far end of the bar is not refined: one face");
        var top = Pairs(mesh.SurfaceFaces).Where(f => f.Face == 1 && mesh.HexIds[f.Element] == 1).ToList();
        Assert.That(top, Has.Count.EqualTo(9), "the top of the refined cube is 3 x 3 small faces");

        var one = top[4];
        var setup = facade.SelectFaces(Session, coarse, new[] { Ref(mesh, one.Element, one.Face) }, "fix", null);
        var after = facade.GetMesh(Session, coarse);

        Assert.That(Pairs(after.FixedFaces).ToList(), Is.EqualTo(new[] { one }), "exactly the face that was pointed at, not the top of the cube");
        Assert.That(setup.Version, Is.GreaterThan(0));

        // taking it away again leaves nothing
        facade.SelectFaces(Session, coarse, new[] { Ref(mesh, one.Element, one.Face) }, "unfix", null);
        Assert.That(facade.GetMesh(Session, coarse).FixedFaces, Is.Empty);
    }

    [Test]
    public void Pressing_one_face_and_then_another_with_a_different_pressure_keeps_each_on_its_own_face()
    {
        var facade = NewFacade();
        var coarse = Export(Bar(2));
        facade.AddLocalRefinement(Session, coarse, Cube(0, 2));
        var mesh = facade.GetMesh(Session, coarse);
        var top = Pairs(mesh.SurfaceFaces).Where(f => f.Face == 1 && mesh.HexIds[f.Element] == 0).ToList();
        Assert.That(top, Has.Count.EqualTo(4));

        facade.SelectFaces(Session, coarse, new[] { Ref(mesh, top[0].Element, 1), Ref(mesh, top[1].Element, 1) }, "load", -1e6);
        facade.SelectFaces(Session, coarse, new[] { Ref(mesh, top[1].Element, 1) }, "load", -3e6);
        var after = facade.GetMesh(Session, coarse);

        var loaded = Pairs(after.LoadedFaces).Zip(after.Pressures).ToDictionary(p => p.First, p => p.Second);
        Assert.That(loaded, Has.Count.EqualTo(2));
        Assert.That(loaded[top[0]], Is.EqualTo(-1e6));
        Assert.That(loaded[top[1]], Is.EqualTo(-3e6));
        Assert.That(loaded.ContainsKey(top[2]), Is.False);

        facade.SelectFaces(Session, coarse, new[] { Ref(mesh, top[0].Element, 1) }, "unload", null);
        Assert.That(Pairs(facade.GetMesh(Session, coarse).LoadedFaces).ToList(), Is.EqualTo(new[] { top[1] }));
    }

    [Test]
    public void A_face_that_is_not_on_a_side_of_a_cube_or_a_key_that_is_not_there_changes_nothing()
    {
        var facade = NewFacade();
        var coarse = Export(Bar(2));
        facade.AddLocalRefinement(Session, coarse, Cube(0, 2));
        var mesh = facade.GetMesh(Session, coarse);
        int version = facade.GetSetup(Session).Version;

        // a face inside the refined cube, between two small elements (its plane is the middle of the cube, x, y or z = 0.5): not a side of a cube
        (int Element, int Face) inside = default;
        for (int e = 0; e < mesh.ElementCount && inside == default; e++)
            for (int f = 0; f < 6; f++)
            {
                var (axis, _) = ElementLocal.FaceAxis(f);
                if (mesh.HexIds[e] == coarse.ElementIds[0] && ElementLocal.FaceNodes[f].Where(n => n < 8).All(n => Math.Abs(mesh.Positions[3 * mesh.Connectivity[20 * e + n] + axis] - 0.5) < 1e-9)) { inside = (e, f); break; }
            }
        Assert.That(inside, Is.Not.EqualTo(default((int, int))), "the refined cube has a face in its middle");
        facade.SelectFaces(Session, coarse, new[] { Ref(mesh, inside.Element, inside.Face) }, "fix", null);
        facade.SelectFaces(Session, coarse, new[] { new ElementFaceRefDto("no such element", 1), new ElementFaceRefDto(mesh.Keys[0], 9) }, "fix", null);
        facade.SelectFaces(Session, coarse, new[] { Ref(mesh, 0, 0) }, "explode", null);
        facade.SelectFaces(Session, coarse, new[] { Ref(mesh, 0, 0) }, "load", double.NaN);

        Assert.That(facade.GetSetup(Session).Version, Is.EqualTo(version));
        Assert.That(facade.GetMesh(Session, coarse).FixedFaces, Is.Empty);
    }

    [Test]
    public void Painting_one_element_of_the_refined_mesh_gives_a_material_to_that_element_alone()
    {
        var facade = NewFacade();
        var coarse = Export(Bar(3));
        facade.AddLocalRefinement(Session, coarse, Cube(1, 2));
        var mesh = facade.GetMesh(Session, coarse);
        int chosen = Enumerable.Range(0, mesh.ElementCount).First(e => mesh.HexIds[e] == coarse.ElementIds[1]);

        facade.PaintElements(Session, coarse, new[] { mesh.Keys[chosen] }, "rubber");
        var after = facade.GetMesh(Session, coarse);

        Assert.That(after.Materials[chosen], Is.EqualTo("rubber"));
        Assert.That(after.Materials.Where((_, e) => e != chosen), Is.All.EqualTo("steel"), "the others, whole cubes and fine elements alike, stay as they were");
        facade.PaintElements(Session, coarse, new[] { mesh.Keys[chosen] }, null);
        Assert.That(facade.GetMesh(Session, coarse).Materials, Is.All.EqualTo("steel"));
        facade.PaintElements(Session, coarse, new[] { mesh.Keys[chosen] }, "unobtainium");
        Assert.That(facade.GetMesh(Session, coarse).Materials, Is.All.EqualTo("steel"), "an unknown material is refused");
    }

    [Test]
    public void The_bar_pulled_through_the_front_door_on_a_refined_mesh_has_the_exact_answer()
    {
        var facade = NewFacade();
        facade.UpsertMaterial(Session, new SolverMaterialDto("steel0", "S", 2.0e11, 0.0));
        facade.SetDefaultMaterial(Session, "steel0");
        var coarse = Export(Bar(4));
        facade.AddLocalRefinement(Session, coarse, Cube(1, 3));
        facade.AddLocalRefinement(Session, coarse, new RefinementStepDto(
            facade.GetMesh(Session, coarse).Keys.Where((_, e) => facade.GetMesh(Session, coarse).HexIds[e] == coarse.ElementIds[2]).Take(1).ToList(), 2, 2, 2));
        var mesh = facade.GetMesh(Session, coarse);
        var clamped = SurfaceOnPlaneX(mesh, 0.0, 4);
        var pulled = SurfaceOnPlaneX(mesh, 4.0, 5);
        Assert.That(clamped, Is.Not.Empty);
        Assert.That(pulled, Is.Not.Empty);

        // the faces are pointed at one by one on the mesh, as a click does
        facade.SelectFaces(Session, coarse, clamped.Select(f => Ref(mesh, f.Element, f.Face)).ToList(), "fix", null);
        facade.SelectFaces(Session, coarse, pulled.Select(f => Ref(mesh, f.Element, f.Face)).ToList(), "load", 1e6);
        var validation = facade.Validate(Session, coarse);
        var job = SolveAndWait(facade, Session, coarse);
        var result = facade.GetResult(Session)!;

        Assert.That(validation.CanSolve, Is.True, string.Join("; ", validation.Issues.Select(i => i.Message)));
        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        Assert.That(result.GridNodes, Is.Empty, "a mesh that is not cut evenly has no grid of nodes: it is shown from the mesh itself");
        Assert.That(result.Ux, Has.Count.EqualTo(mesh.NodeCount));
        for (int n = 0; n < mesh.NodeCount; n++)
        {
            Assert.That(result.Ux[n], Is.EqualTo(1e6 * mesh.Positions[3 * n] / 2.0e11).Within(1e-9), $"node {n}");
            Assert.That(result.VonMises[n], Is.EqualTo(1e6).Within(1));
        }
    }

    [Test]
    public void Quality_names_the_flagged_elements_of_a_refined_mesh_by_key_and_one_element_can_be_asked_for_by_key()
    {
        var facade = NewFacade();
        var editor = Bar(3);
        editor.MoveNode(editor.Mesh.Hex(1).NodeIds[6], new Solvix.Mesh.Vec3(1.6, 1.6, 1.9), false);       // spoil the middle cube a little
        var coarse = Export(editor);
        facade.AddLocalRefinement(Session, coarse, Cube(1, 2));

        var report = facade.Quality(Session, coarse);
        var solvix = report.Profiles.First(p => p.Id == "solvix");
        var mesh = facade.GetMesh(Session, coarse);

        Assert.That(solvix.Elements, Is.EqualTo(mesh.ElementCount));
        Assert.That(solvix.Flagged, Is.Not.Empty);
        Assert.That(solvix.Flagged.All(f => f.Key is not null && mesh.Keys.Contains(f.Key)), Is.True);
        var one = facade.QualityOfElementByKey(Session, coarse, solvix.Flagged[0].Key!);
        Assert.That(one, Is.Not.Null);
        Assert.That(one!.Profiles.First(p => p.Id == "solvix").Values.Keys, Is.EquivalentTo(solvix.Flagged[0].Values.Keys));
        Assert.That(facade.QualityOfElementByKey(Session, coarse, "no such element"), Is.Null);
    }
}
