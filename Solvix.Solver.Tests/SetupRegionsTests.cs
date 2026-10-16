using Solvix.Contracts.Facades;
using Solvix.FemMesh;
using Solvix.FemMesh.Local;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>What is set is stored as regions of the cubes, not as cells of a division: the division can change without losing or inventing anything.</summary>
public class SetupRegionsTests
{
    private const int Session = 1;

    [Test]
    public void A_selection_survives_the_division_going_finer_and_coarser_again_exactly()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 3, 3, 3);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "ZMinus", 1, 2), new SolverFaceDto(0, "ZMinus", 0, 0) }, true);
        var before = facade.GetSetup(Session).Fixed;

        facade.SetDivisions(Session, 6, 6, 6);
        var finer = facade.GetSetup(Session).Fixed;
        facade.SetDivisions(Session, 2, 2, 2);                     // a grid the regions do not line up with
        facade.SetDivisions(Session, 3, 3, 3);

        Assert.That(finer, Has.Count.EqualTo(2 * 4), "each old cell is 2 x 2 new ones");
        Assert.That(facade.GetSetup(Session).Fixed, Is.EqualTo(before), "back on the old grid the very same cells, whatever grids were in between");
    }

    [Test]
    public void Taking_one_cell_out_of_a_selection_made_on_a_coarser_grid_leaves_the_rest_of_it()
    {
        var facade = NewFacade();
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "XPlus") }, -1e6);                // the whole side, one cell
        facade.SetDivisions(Session, 2, 2, 2);                                                     // now 4 cells of it
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "XPlus", 1, 0) }, null);              // one taken away

        var loads = facade.GetSetup(Session).Loads;

        Assert.That(loads.Select(l => (l.P, l.Q)), Is.EquivalentTo(new (int?, int?)[] { (0, 0), (0, 1), (1, 1) }));
        Assert.That(loads.All(l => l.Pressure == -1e6), Is.True);
    }

    [Test]
    public void A_new_value_on_a_cell_replaces_the_old_one_there_only()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "XPlus") }, -1e6);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "XPlus", 0, 1) }, -3e6);

        var loads = facade.GetSetup(Session).Loads.ToDictionary(l => (l.P, l.Q), l => l.Pressure);

        Assert.That(loads, Has.Count.EqualTo(4));
        Assert.That(loads[(0, 1)], Is.EqualTo(-3e6));
        Assert.That(loads[(0, 0)], Is.EqualTo(-1e6));
        Assert.That(loads[(1, 1)], Is.EqualTo(-1e6));
    }

    [Test]
    public void Materials_given_to_parts_of_a_cube_are_regions_that_the_division_cuts_up_however_it_likes()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);
        facade.SetElementMaterial(Session, new[] { new SolverElementDto(0, 1, 0, 1) }, "rubber");

        facade.SetDivisions(Session, 4, 4, 4);
        var finer = facade.GetSetup(Session).ElementMaterials;
        facade.SetDivisions(Session, 2, 2, 2);

        Assert.That(finer, Has.Count.EqualTo(8));
        Assert.That(facade.GetSetup(Session).ElementMaterials.Select(m => (m.Ex, m.Ey, m.Ez, m.Material)), Is.EqualTo(new[] { (1, 0, 1, "rubber") }));
    }

    [Test]
    public void A_region_finer_than_the_mesh_still_binds_to_the_right_faces_whatever_the_rule()
    {
        // the pressure was put on a quarter of a side (a cell of a 2 x 2 grid); a mesh cut 4 x 4 has 4 faces there, a 1 x 1 mesh has the whole face, which owns its centre in no quarter...
        var coarse = Export(Bar(2));
        var setup = new SolverSetup();
        setup.SetDivisions(2, 2, 2);
        setup.SetLoads(setup.Expand(coarse.ElementIds[1], "XPlus", 1, 0), -1e6);

        var fourByFour = SolverFacade.BuildProblem(setup, coarse, new UniformRefinement(4, 4, 4).Build(coarse));
        var local = SolverFacade.BuildProblem(setup, coarse, new LocalRefinement(new[] { new RefinementStep(new[] { LocalRefinement.RootKey(1) }, 3, 3, 3) }).Build(coarse));

        Assert.That(fourByFour.Loads.Pressures, Has.Count.EqualTo(4));
        Assert.That(fourByFour.Loads.Pressures.All(p => p.Face.Face == 5), Is.True);
        Assert.That(local.Loads.Pressures.Count, Is.GreaterThan(0).And.LessThan(9), "a 3 x 3 cut of the side: the quarter owns the faces whose centres lie in it");
        // on both meshes the faces that got the pressure lie in the one quarter of the side
        foreach (var problem in new[] { fourByFour, local })
        {
            var mesh = problem == fourByFour ? new UniformRefinement(4, 4, 4).Build(coarse) : new LocalRefinement(new[] { new RefinementStep(new[] { LocalRefinement.RootKey(1) }, 3, 3, 3) }).Build(coarse);
            foreach (var p in problem.Loads.Pressures)
            {
                var at = mesh.FaceCentreOf(new Solvix.FemMesh.ElementFace(p.Face.Element, p.Face.Face));
                Assert.That(at.Y, Is.GreaterThanOrEqualTo(0).And.LessThan(1));          // cell p = 1 along the lower tangent axis (y), q = 0 along z
                Assert.That(at.Z, Is.GreaterThanOrEqualTo(-1).And.LessThan(0));
            }
        }
    }

    [Test]
    public void Undo_and_redo_bring_back_the_regions_not_just_the_cells()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 4, 4, 4);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "ZMinus", 1, 1) }, true);
        facade.SetDivisions(Session, 2, 2, 2);
        var onCoarse = facade.GetSetup(Session).Fixed;

        facade.UndoSetup(Session);                                  // back to 4 x 4 x 4
        var undone = facade.GetSetup(Session);
        facade.RedoSetup(Session);

        Assert.That(undone.Divisions, Is.EqualTo(new[] { 4, 4, 4 }));
        Assert.That(undone.Fixed, Is.EqualTo(new[] { new SolverFaceDto(0, "ZMinus", 1, 1) }));
        Assert.That(facade.GetSetup(Session).Fixed, Is.EqualTo(onCoarse));
    }
}
