using NUnit.Framework;
using Solvix.Contracts.Facades;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

public class SetupUndoTests
{
    private const int Session = 1;
    private static readonly SolverFaceDto[] Side = { new(0, "XMinus", null, null) };

    [Test]
    public void Undo_takes_back_the_last_change_of_the_set_up_whatever_it_was_and_redo_puts_it_back()
    {
        var facade = NewFacade();
        Assert.That(facade.GetSetup(Session).CanUndo, Is.False);

        facade.SetFixedFaces(Session, Side, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "XPlus", null, null) }, -5e6);
        facade.SetDivisions(Session, 2, 2, 2);
        var done = facade.GetSetup(Session);
        Assert.That(done.CanUndo, Is.True);
        Assert.That(done.Divisions, Is.EqualTo(new[] { 2, 2, 2 }));

        var step1 = facade.UndoSetup(Session);                       // the division
        Assert.That(step1.Divisions, Is.EqualTo(new[] { 1, 1, 1 }));
        Assert.That(step1.Loads, Has.Count.EqualTo(1));
        var step2 = facade.UndoSetup(Session);                       // the pressure
        Assert.That(step2.Loads, Is.Empty);
        Assert.That(step2.Fixed, Is.Not.Empty);
        var step3 = facade.UndoSetup(Session);                       // the support
        Assert.That(step3.Fixed, Is.Empty);
        Assert.That(step3.CanUndo, Is.False);
        Assert.That(step3.CanRedo, Is.True);

        facade.RedoSetup(Session);
        facade.RedoSetup(Session);
        var back = facade.RedoSetup(Session);
        Assert.That(back.Divisions, Is.EqualTo(new[] { 2, 2, 2 }));
        Assert.That(back.Loads, Is.Not.Empty);
        Assert.That(back.Fixed, Is.Not.Empty);
        Assert.That(back.CanRedo, Is.False);
    }

    [Test]
    public void A_change_that_changes_nothing_leaves_no_step()
    {
        var facade = NewFacade();

        facade.SetFixedFaces(Session, Side, false);                  // nothing was fixed
        facade.SetLoads(Session, Side, null);                        // no pressure to remove
        facade.SetDivisions(Session, 1, 1, 1);                       // the same division

        Assert.That(facade.GetSetup(Session).CanUndo, Is.False);
    }

    [Test]
    public void A_new_change_after_an_undo_ends_the_redo()
    {
        var facade = NewFacade();
        facade.SetFixedFaces(Session, Side, true);
        facade.UndoSetup(Session);
        Assert.That(facade.GetSetup(Session).CanRedo, Is.True);

        facade.SetLoads(Session, Side, -1e6);

        Assert.That(facade.GetSetup(Session).CanRedo, Is.False);
    }

    [Test]
    public void The_materials_and_the_default_material_are_undone_too()
    {
        var facade = NewFacade();
        var before = facade.GetSetup(Session);
        facade.SetHexMaterial(Session, new[] { 0, 1 }, before.Materials.First(m => m.Name != before.DefaultMaterial).Name);
        facade.SetDefaultMaterial(Session, before.Materials.First(m => m.Name != before.DefaultMaterial).Name);

        facade.UndoSetup(Session);
        Assert.That(facade.GetSetup(Session).DefaultMaterial, Is.EqualTo(before.DefaultMaterial));
        facade.UndoSetup(Session);

        var undone = facade.GetSetup(Session);
        Assert.That(undone.HexMaterials, Is.Empty);
        Assert.That(undone.CanUndo, Is.False);
    }

    [Test]
    public void Undo_with_nothing_to_undo_changes_nothing()
    {
        var facade = NewFacade();

        var setup = facade.UndoSetup(Session);

        Assert.That(setup.CanUndo, Is.False);
        Assert.That(setup.CanRedo, Is.False);
        Assert.That(facade.RedoSetup(Session).CanRedo, Is.False);
    }

    [Test]
    public void A_division_undone_gives_back_the_regions_that_were_cut_finer_by_it()
    {
        var facade = NewFacade();
        facade.SetFixedFaces(Session, Side, true);
        var before = facade.GetSetup(Session).Fixed;
        facade.SetDivisions(Session, 3, 3, 3);
        Assert.That(facade.GetSetup(Session).Fixed.Count, Is.GreaterThan(before.Count));

        var undone = facade.UndoSetup(Session);

        Assert.That(undone.Fixed.Count, Is.EqualTo(before.Count));
    }
}
