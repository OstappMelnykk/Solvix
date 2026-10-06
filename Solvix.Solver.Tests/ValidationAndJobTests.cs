using Solvix.Contracts.Facades;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

public class ValidationAndJobTests
{
    private const int Session = 1;

    private static ISolverFacade Prepared(int cubes = 2)
    {
        var facade = NewFacade();
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(cubes - 1, "XPlus") }, 1e5);
        return facade;
    }

    private static IEnumerable<string> Errors(SolverValidationDto v) => v.Issues.Where(i => i.Severity == "error").Select(i => i.Message);
    private static IEnumerable<string> Warnings(SolverValidationDto v) => v.Issues.Where(i => i.Severity == "warning").Select(i => i.Message);

    // ---- validation -------------------------------------------------------------------------------

    [Test]
    public void A_good_setup_can_be_solved_with_no_complaints()
    {
        var validation = Prepared().Validate(Session, Export(Bar(2)));

        Assert.That(validation.CanSolve, Is.True);
        Assert.That(validation.Issues, Is.Empty);
    }

    [Test]
    public void An_empty_mesh_cannot_be_solved()
    {
        var validation = Prepared().Validate(Session, Export(new HexMeshEditor()));

        Assert.That(validation.CanSolve, Is.False);
        Assert.That(Errors(validation).Single(), Does.Contain("Немає жодного куба"));
    }

    [Test]
    public void Without_a_support_the_body_would_float_and_the_message_says_so()
    {
        var facade = NewFacade();
        facade.SetLoads(Session, new[] { new SolverFaceDto(1, "XPlus") }, 1e5);

        var validation = facade.Validate(Session, Export(Bar(2)));

        Assert.That(validation.CanSolve, Is.False);
        Assert.That(Errors(validation), Has.Some.Contain("Закріпіть"));
    }

    [Test]
    public void Without_a_load_it_still_solves_but_warns()
    {
        var facade = NewFacade();
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);

        var validation = facade.Validate(Session, Export(Bar(2)));

        Assert.That(validation.CanSolve, Is.True);
        Assert.That(Warnings(validation), Has.Some.Contain("Немає навантаження"));
    }

    [Test]
    public void A_separate_part_without_its_own_support_is_an_error_naming_its_cubes()
    {
        var editor = Bar(2);
        editor.AddBody(HexTemplates.Kind("block").Build(new Dictionary<string, double> { ["countX"] = 1, ["countY"] = 1, ["countZ"] = 1 }));   // a second, unlinked body (hex 2)
        var facade = Prepared(2);

        var validation = facade.Validate(Session, Export(editor));

        Assert.That(validation.CanSolve, Is.False);
        Assert.That(Errors(validation).Single(), Does.Contain("не закріплена").And.Contain("2"));
    }

    [Test]
    public void Two_supported_parts_are_fine_with_a_note_that_they_do_not_interact()
    {
        var editor = Bar(2);
        editor.AddBody(HexTemplates.Kind("block").Build(new Dictionary<string, double> { ["countX"] = 1, ["countY"] = 1, ["countZ"] = 1 }));
        var facade = Prepared(2);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(2, "XMinus") }, true);

        var validation = facade.Validate(Session, Export(editor));

        Assert.That(validation.CanSolve, Is.True);
        Assert.That(Warnings(validation), Has.Some.Contain("окремих частин"));
    }

    [Test]
    public void Folded_cubes_block_the_solve()
    {
        var editor = Bar(2);
        editor.MoveNode(editor.Mesh.Hex(0).NodeIds[6], new Vec3(-3, -3, -3), false);

        var validation = Prepared().Validate(Session, Export(editor));

        Assert.That(validation.CanSolve, Is.False);
        Assert.That(Errors(validation), Has.Some.Contain("Вивернуті"));
    }

    [Test]
    public void References_to_deleted_cubes_are_ignored_with_a_warning()
    {
        var facade = Prepared();
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(77, "XMinus") }, true);

        var validation = facade.Validate(Session, Export(Bar(2)));

        Assert.That(validation.CanSolve, Is.True);
        Assert.That(Warnings(validation), Has.Some.Contain("видалені куби"));
    }

    [Test]
    public void A_face_both_fixed_and_loaded_is_a_warning()
    {
        var facade = Prepared();
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(1, "XPlus") }, true);

        Assert.That(Warnings(facade.Validate(Session, Export(Bar(2)))), Has.Some.Contain("одночасно"));
    }

    [Test]
    public void An_unknown_material_name_on_a_cube_falls_back_to_the_default()
    {
        var facade = Prepared();
        facade.UpsertMaterial(Session, new SolverMaterialDto("steel", "Сталь", 2.1e11, 0.3));
        // the library only accepts valid materials, so make one unusable by deleting it through the back door: an unknown name on a cube
        var setupSessions = new SolverSessions();
        var direct = new SolverFacade(setupSessions);
        direct.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        setupSessions.With(Session, s => { s.Setup.SetMaterial(new[] { 0 }, "ghost"); return 0; });

        var validation = direct.Validate(Session, Export(Bar(2)));

        Assert.That(validation.CanSolve, Is.True);   // an unknown name falls back to the default material
    }

    [Test]
    public void Too_many_cubes_are_refused_before_any_work()
    {
        var mesh = new FemMeshDto(1, SolverValidator.MaxElements + 1, new double[3], new int[20], new[] { 0 }, Enumerable.Range(0, SolverValidator.MaxElements + 1).ToArray(), Array.Empty<int>());

        var validation = Prepared().Validate(Session, mesh with { Connectivity = new int[20 * (SolverValidator.MaxElements + 1)] });

        Assert.That(Errors(validation), Has.Some.Contain("Забагато"));
    }

    // ---- the background job -----------------------------------------------------------------------

    [Test]
    public void A_solve_reports_progress_and_ends_done_with_a_result_for_its_ticket()
    {
        var notes = new List<SolverJobDto>();
        var sessions = new SolverSessions();
        var facade = new SolverFacade(sessions, new RecordingNotifier(notes));
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(2, "XPlus") }, 1e5);

        var started = facade.StartSolve(Session, Export(Bar(3)));
        var job = started;
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (job.State == "running" && DateTime.UtcNow < deadline) { Thread.Sleep(10); job = facade.GetJob(Session); }

        Assert.That(started.State, Is.EqualTo("running"));
        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        Assert.That(job.Progress, Is.EqualTo(1));
        Assert.That(facade.GetResult(Session)!.Ticket, Is.EqualTo(job.Ticket));
        lock (notes)
        {
            Assert.That(notes.Last().State, Is.EqualTo("done"));
            var running = notes.Where(n => n.State == "running").Select(n => n.Progress).ToList();
            Assert.That(running, Is.Ordered);                         // progress never goes backwards
            Assert.That(notes.Select(n => n.Ticket).Distinct(), Is.EqualTo(new[] { job.Ticket }));
        }
    }

    [Test]
    public void Starting_again_while_running_reports_the_running_job_instead_of_a_second_one()
    {
        var facade = Prepared(4);
        var mesh = Export(Bar(4));

        var first = facade.StartSolve(Session, mesh);
        var second = facade.StartSolve(Session, mesh);
        var finished = SolveAndWait(facade, Session, mesh);

        Assert.That(second.Ticket, Is.EqualTo(first.Ticket));
        Assert.That(finished.State, Is.EqualTo("done"));
    }

    [Test]
    public void A_solve_that_fails_validation_reports_failed_with_the_reasons_and_starts_nothing()
    {
        var facade = NewFacade();

        var job = facade.StartSolve(Session, Export(Bar(2)));

        Assert.That(job.State, Is.EqualTo("failed"));
        Assert.That(job.Error, Does.Contain("Закріпіть"));
        Assert.That(facade.GetResult(Session), Is.Null);
    }

    [Test]
    public void A_running_solve_can_be_cancelled()
    {
        var facade = Prepared(8);
        var editor = new HexMeshEditor();
        editor.AddBody(HexTemplates.Kind("sphere").Build(new Dictionary<string, double> { ["around"] = 10 }));
        var cubes = editor.Mesh.Hexes.ToList();
        facade.ClearSetup(Session);
        facade.SetFixedFaces(Session, cubes.Where(h => h.Cell.K == 0).Select(h => new SolverFaceDto(h.Id, "ZMinus")).ToList(), true);
        facade.SetLoads(Session, cubes.Where(h => h.Cell.K == 9).Select(h => new SolverFaceDto(h.Id, "ZPlus")).ToList(), 1e6);

        facade.StartSolve(Session, Export(editor));
        var cancelled = facade.CancelSolve(Session);
        var deadline = DateTime.UtcNow.AddSeconds(60);
        var job = facade.GetJob(Session);
        while (job.State == "running" && DateTime.UtcNow < deadline) { Thread.Sleep(10); job = facade.GetJob(Session); }

        Assert.That(cancelled.State, Is.EqualTo("running").Or.EqualTo("cancelled"));
        Assert.That(job.State, Is.EqualTo("cancelled"));
        Assert.That(facade.GetResult(Session), Is.Null);
    }

    [Test]
    public void A_new_solve_replaces_the_result_of_the_old_one()
    {
        var facade = Prepared();
        var mesh = Export(Bar(2));
        SolveAndWait(facade, Session, mesh);
        var first = facade.GetResult(Session)!;

        facade.SetLoads(Session, new[] { new SolverFaceDto(1, "XPlus") }, 2e5);
        SolveAndWait(facade, Session, mesh);
        var second = facade.GetResult(Session)!;

        Assert.That(second.Ticket, Is.GreaterThan(first.Ticket));
        Assert.That(second.MaxDisplacement, Is.EqualTo(2 * first.MaxDisplacement).Within(first.MaxDisplacement * 1e-6));
    }

    [Test]
    public void Cancelling_when_nothing_runs_changes_nothing()
    {
        var facade = NewFacade();

        Assert.That(facade.CancelSolve(Session).State, Is.EqualTo("idle"));
        Assert.That(facade.GetJob(Session).State, Is.EqualTo("idle"));
    }

    private sealed class RecordingNotifier(List<SolverJobDto> notes) : ISolverProgressNotifier
    {
        public Task JobChanged(int sessionId, SolverJobDto job)
        {
            lock (notes) notes.Add(job);
            return Task.CompletedTask;
        }
    }
}
