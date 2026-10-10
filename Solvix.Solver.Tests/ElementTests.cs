using Solvix.Contracts.Facades;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

// What can be set on a single small face or a single small element of a divided cube.
public class ElementTests
{
    private const int Session = 1;

    // ---- small faces --------------------------------------------------------------------------------

    [Test]
    public void A_whole_side_is_all_its_small_faces_and_one_cell_is_just_that_cell()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 3, 4);

        var whole = facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XPlus") }, true);
        Assert.That(whole.Fixed, Has.Count.EqualTo(3 * 4));                         // an X side is ny * nz cells
        Assert.That(whole.Fixed.All(f => f.P is >= 0 and < 3 && f.Q is >= 0 and < 4), Is.True);

        var one = facade.ReplaceFixedFaces(Session, new[] { new SolverFaceDto(0, "ZMinus", 1, 2) });
        Assert.That(one.Fixed, Is.EqualTo(new[] { new SolverFaceDto(0, "ZMinus", 1, 2) }));
    }

    [Test]
    public void A_cell_outside_the_grid_is_ignored()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);

        var setup = facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XPlus", 2, 0), new SolverFaceDto(0, "XPlus", 0, -1), new SolverFaceDto(0, "XPlus", 1, 1) }, true);

        Assert.That(setup.Fixed, Is.EqualTo(new[] { new SolverFaceDto(0, "XPlus", 1, 1) }));
    }

    [Test]
    public void One_cell_can_be_unmarked_while_the_rest_of_the_side_stays()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "YPlus") }, -1e6);

        var setup = facade.SetLoads(Session, new[] { new SolverFaceDto(0, "YPlus", 0, 1) }, null);

        Assert.That(setup.Loads, Has.Count.EqualTo(3));
        Assert.That(setup.Loads.Any(l => l.P == 0 && l.Q == 1), Is.False);
    }

    [Test]
    public void Different_cells_of_a_side_can_carry_different_pressures()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 1, 1);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "ZPlus", 0, 0) }, -1e6);

        var setup = facade.SetLoads(Session, new[] { new SolverFaceDto(0, "ZPlus", 1, 0) }, -3e6);

        Assert.That(setup.Loads.Select(l => (l.P, l.Pressure)), Is.EquivalentTo(new (int?, double)[] { (0, -1e6), (1, -3e6) }));
    }

    [Test]
    public void The_small_face_names_the_small_element_behind_it()
    {
        var fine = FineMesh.Build(Export(Bar(1)), 2, 3, 4);

        // XMinus: element index 0 along x, (p, q) = (ey, ez); ZPlus: ez = last, (p, q) = (ex, ey); YPlus: ey = last, (p, q) = (ex, ez)
        var xMinus = fine.BoundaryElement(0, "XMinus", 2, 3);
        var zPlus = fine.BoundaryElement(0, "ZPlus", 1, 2);
        var yPlus = fine.BoundaryElement(0, "YPlus", 1, 3);

        Assert.That((fine.Ex[xMinus.Element], fine.Ey[xMinus.Element], fine.Ez[xMinus.Element]), Is.EqualTo((0, 2, 3)));
        Assert.That((fine.Ex[zPlus.Element], fine.Ey[zPlus.Element], fine.Ez[zPlus.Element]), Is.EqualTo((1, 2, 3)));
        Assert.That((fine.Ex[yPlus.Element], fine.Ey[yPlus.Element], fine.Ez[yPlus.Element]), Is.EqualTo((1, 2, 3)));
        Assert.That(new[] { xMinus.SolverFace, zPlus.SolverFace, yPlus.SolverFace }, Is.EqualTo(new[] { 4, 1, 3 }));
    }

    [Test]
    public void Clamping_only_one_small_face_leaves_the_rest_of_the_side_free_to_move()
    {
        var facade = NewFacade();
        facade.UpsertMaterial(Session, new SolverMaterialDto("m", "M", 2e11, 0.0));
        facade.SetDefaultMaterial(Session, "m");
        facade.SetDivisions(Session, 1, 2, 1);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus", 0, 0) }, true);        // the half of the left side at y < 0.5
        facade.SetLoads(Session, new[] { new SolverFaceDto(1, "XPlus") }, -1e6);

        var job = SolveAndWait(facade, Session, Export(Bar(2)));

        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        var result = facade.GetResult(Session)!;
        var onLeft = Enumerable.Range(0, result.Ux.Count).Where(i => Math.Abs(result.Positions[3 * i]) < 1e-9).ToList();
        var clamped = onLeft.Where(i => result.Positions[3 * i + 1] < 0.5 - 1e-9).ToList();
        var free = onLeft.Where(i => result.Positions[3 * i + 1] > 0.5 + 1e-9).ToList();
        Assert.That(clamped.All(i => Math.Abs(result.Ux[i]) < 1e-15), Is.True);
        Assert.That(free.Any(i => Math.Abs(result.Ux[i]) > 1e-12), Is.True);       // the unclamped half is pushed
    }

    // ---- the division changes under what was chosen --------------------------------------------------

    [Test]
    public void Refining_the_division_keeps_a_selected_cell_as_all_the_cells_it_was_cut_into()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus", 1, 0) }, true);          // the y >= 0.5, z < 0.5 quarter of the left side

        var setup = facade.SetDivisions(Session, 4, 4, 4);

        Assert.That(setup.Fixed.Select(f => (f.P, f.Q)), Is.EquivalentTo(new (int?, int?)[] { (2, 0), (2, 1), (3, 0), (3, 1) }));
    }

    [Test]
    public void Coarsening_keeps_the_cells_whose_centre_was_inside_a_selected_one_and_loses_smaller_bits()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 4, 4, 4);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "ZPlus", 3, 3), new SolverFaceDto(0, "ZPlus", 0, 0) }, -2e6);   // the cell at (0.75..1, 0.75..1) and one at the origin

        var setup = facade.SetDivisions(Session, 2, 2, 2);

        // the new cell (1, 1) has its centre (0.75, 0.75) inside the first; the new cell (0, 0) has its centre (0.25, 0.25) in old cell (1, 1), which was not selected
        Assert.That(setup.Loads.Select(l => (l.P, l.Q, l.Pressure)), Is.EqualTo(new (int?, int?, double)[] { (1, 1, -2e6) }));
    }

    [Test]
    public void Changing_only_one_axis_remaps_only_what_depends_on_it()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 1, 1);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "ZMinus", 1, 0) }, true);          // the right half in x

        var setup = facade.SetDivisions(Session, 4, 1, 1);

        Assert.That(setup.Fixed.Select(f => (f.P, f.Q)), Is.EquivalentTo(new (int?, int?)[] { (2, 0), (3, 0) }));
    }

    [Test]
    public void Setting_the_same_division_again_changes_nothing()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus", 1, 1) }, true);
        int version = facade.GetSetup(Session).Version;

        var setup = facade.SetDivisions(Session, 2, 2, 2);

        Assert.That(setup.Version, Is.EqualTo(version));
        Assert.That(setup.Fixed, Has.Count.EqualTo(1));
    }

    // ---- materials of single small elements -----------------------------------------------------------

    [Test]
    public void A_small_element_can_have_a_material_different_from_its_cube()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);

        var setup = facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 1, 0, 1), new SolverElementDto(0, 0, 0, 0) }, "rubber");

        Assert.That(setup.ElementMaterials.Select(m => (m.Ex, m.Ey, m.Ez, m.Material)), Is.EquivalentTo(new[] { (1, 0, 1, "rubber"), (0, 0, 0, "rubber") }));
        Assert.That(setup.HexMaterials, Is.Empty);
    }

    [Test]
    public void An_element_given_its_cubes_own_material_goes_back_to_following_the_cube()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 1, 1);
        facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 0, 0, 0) }, "rubber");

        Assert.That(facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 0, 0, 0) }, "steel").ElementMaterials, Is.Empty);        // steel is the default
        facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 1, 0, 0) }, "rubber");
        Assert.That(facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 1, 0, 0) }, null).ElementMaterials, Is.Empty);
    }

    [Test]
    public void Giving_a_whole_cube_a_material_wipes_the_materials_of_its_elements()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 1, 1);
        facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 0, 0, 0), new SolverElementDto(1, 0, 0, 0) }, "rubber");

        var setup = facade.SetHexMaterial(Session, new[] { 0 }, "concrete");

        Assert.That(setup.ElementMaterials.Select(m => m.Hex), Is.EqualTo(new[] { 1 }));
        Assert.That(setup.HexMaterials[0], Is.EqualTo("concrete"));
    }

    [Test]
    public void Elements_outside_the_division_and_unknown_materials_are_ignored()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);

        var setup = facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 2, 0, 0), new SolverElementDto(0, 0, -1, 0) }, "rubber");
        var unknown = facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 0, 0, 0) }, "unobtainium");

        Assert.That(setup.ElementMaterials, Is.Empty);
        Assert.That(unknown.ElementMaterials, Is.Empty);
    }

    [Test]
    public void The_materials_of_elements_follow_a_change_of_the_division()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);
        facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 1, 1, 0) }, "rubber");

        var finer = facade.SetDivisions(Session, 4, 4, 4);
        var back = facade.SetDivisions(Session, 2, 2, 2);

        Assert.That(finer.ElementMaterials, Has.Count.EqualTo(8));                    // one old element = 2*2*2 new ones
        Assert.That(finer.ElementMaterials.All(m => m.Ex >= 2 && m.Ey >= 2 && m.Ez < 2), Is.True);
        Assert.That(back.ElementMaterials.Select(m => (m.Ex, m.Ey, m.Ez)), Is.EqualTo(new[] { (1, 1, 0) }));
    }

    [Test]
    public void Pruning_drops_the_element_materials_of_deleted_cubes()
    {
        var facade = NewFacade();
        facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 0, 0, 0), new SolverElementDto(5, 0, 0, 0) }, "rubber");

        var setup = facade.Prune(Session, new[] { 0 });

        Assert.That(setup.ElementMaterials.Select(m => m.Hex), Is.EqualTo(new[] { 0 }));
    }

    [Test]
    public void Layers_of_different_materials_inside_one_cube_add_up_like_springs_in_series()
    {
        // one cube cut into 4 slices along x: steel, steel, rubber, rubber; nu = 0 so the clamped bar is exactly uniaxial
        var facade = NewFacade();
        facade.UpsertMaterial(Session, new SolverMaterialDto("steel0", "S", 2.0e11, 0.0));
        facade.UpsertMaterial(Session, new SolverMaterialDto("rubber0", "R", 1.0e7, 0.0));
        facade.SetDefaultMaterial(Session, "steel0");
        facade.SetDivisions(Session, 4, 1, 1);
        facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 2, 0, 0), new SolverElementDto(0, 3, 0, 0) }, "rubber0");
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "XPlus") }, -1e5);

        var job = SolveAndWait(facade, Session, Export(Bar(1)));

        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        var result = facade.GetResult(Session)!;
        int tip = Enumerable.Range(0, result.Ux.Count).First(i => Math.Abs(result.Positions[3 * i] - 1) < 1e-12);
        double expected = -1e5 * (0.5 / 2.0e11 + 0.5 / 1.0e7);
        Assert.That(result.Ux[tip], Is.EqualTo(expected).Within(Math.Abs(expected) * 1e-5));
    }

    [Test]
    public void The_validation_notices_a_small_face_that_is_both_clamped_and_pressed()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 1, 1);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "ZPlus", 0, 0) }, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "ZPlus", 0, 0), new SolverFaceDto(0, "ZPlus", 1, 0) }, -1e6);

        var validation = facade.Validate(Session, Export(Bar(1)));

        Assert.That(validation.Issues.Select(i => i.Message), Has.Some.Contain("одночасно"));
        // a different cell of the same side being pressed is fine
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "ZPlus", 0, 0) }, null);
        Assert.That(facade.Validate(Session, Export(Bar(1))).Issues.Select(i => i.Message), Has.None.Contain("одночасно"));
    }
}

public class QualityApiTests
{
    private const int Session = 1;

    [Test]
    public void A_regular_bar_is_all_excellent()
    {
        var q = NewFacade().Quality(Session, Export(Bar(3)));

        Assert.That(q.Elements, Is.EqualTo(3));
        Assert.That(q.Grades["excellent"], Is.EqualTo(3));
        Assert.That(q.WorstScaledJacobian, Is.EqualTo(1).Within(1e-9));
        Assert.That(q.Cubes.Select(c => c.Grade), Is.All.EqualTo("excellent"));
    }

    [Test]
    public void The_quality_counts_the_small_elements_and_names_the_cube_with_the_worst_one()
    {
        var editor = Bar(2);
        editor.MoveNode(editor.Mesh.Hex(1).NodeIds[6], new Vec3(2.0, 1.0, 1.0), false);          // flattens the far top corner of cube 1
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);

        var q = facade.Quality(Session, Export(editor));

        Assert.That(q.Elements, Is.EqualTo(16));
        Assert.That(q.Grades.Values.Sum(), Is.EqualTo(16));
        Assert.That(q.Cubes.Single(c => c.Hex == 0).Grade, Is.EqualTo("excellent"));
        Assert.That(q.Cubes.Single(c => c.Hex == 1).ScaledJacobian, Is.LessThan(1));
        Assert.That(q.WorstScaledJacobian, Is.EqualTo(q.Cubes.Min(c => c.ScaledJacobian)).Within(1e-12));
    }

    [Test]
    public void Flagged_lists_the_small_elements_that_are_not_excellent_with_their_place_in_the_cube()
    {
        var editor = Bar(2);
        editor.MoveNode(editor.Mesh.Hex(1).NodeIds[6], new Vec3(2.9, 1.8, 0.7), false);
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);

        var q = facade.Quality(Session, Export(editor));

        Assert.That(q.Flagged, Is.Not.Empty);
        Assert.That(q.Flagged.All(f => f.Hex == 1), "the regular cube has nothing to flag");
        Assert.That(q.Flagged.All(f => f.Ex is >= 0 and < 2 && f.Ey is >= 0 and < 2 && f.Ez is >= 0 and < 2));
        Assert.That(q.Flagged.Count(f => f.Grade != "excellent"), Is.EqualTo(q.Grades.Where(g => g.Key != "excellent").Sum(g => g.Value)));
        Assert.That(NewFacade().Quality(Session, Export(Bar(3))).Flagged, Is.Empty);
    }

    [Test]
    public void A_folded_cube_is_invalid_and_an_empty_mesh_is_fine()
    {
        var editor = Bar(1);
        editor.MoveNode(editor.Mesh.Hex(0).NodeIds[6], new Vec3(-3, -3, -3), false);

        Assert.That(NewFacade().Quality(Session, Export(editor)).Cubes[0].Grade, Is.EqualTo("invalid"));
        Assert.That(NewFacade().Quality(Session, Export(new HexMeshEditor())).Elements, Is.EqualTo(0));
    }

    [Test]
    public void Validation_warns_about_poor_elements_and_about_a_huge_stiffness_contrast()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex(HexShapes.Parametric(40, 1, 1));                                   // aspect ratio 40: integrable, but poor
        editor.AddHexOnFace(0, HexFace.XPlus, HexShapes.Parametric(40, 1, 1));
        var facade = NewFacade();
        facade.UpsertMaterial(Session, new SolverMaterialDto("hard", "H", 1e12, 0.3));
        facade.UpsertMaterial(Session, new SolverMaterialDto("soft", "S", 1e6, 0.3));
        facade.SetHexMaterial(Session, new[] { 0 }, "hard");
        facade.SetHexMaterial(Session, new[] { 1 }, "soft");
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);

        var messages = facade.Validate(Session, Export(editor)).Issues.Where(i => i.Severity == "warning").Select(i => i.Message).ToList();

        Assert.That(messages, Has.Some.Contain("низьку якість"));
        Assert.That(messages, Has.Some.Contain("відрізняються"));
    }
}
