using Solvix.Control.Models;
using Solvix.Control.Services;

namespace Solvix.Control.Tests;

public class LaunchPlanTests
{
    private static ComponentRow Row(ComponentKind kind, ComponentState state, LauncherKind launcher) =>
        new("k", "n", kind, state, new Launcher(launcher, "x"), "");

    private static StackSnapshot Stack(params ComponentRow[] rows) => new(DateTimeOffset.UnixEpoch, rows, [], true);

    private static string[] Commands(IEnumerable<PlanStep> steps) =>
        steps.OfType<RunStep>().Select(s => s.Arguments).ToArray();

    [Test]
    public void Backend_in_docker_requires_web_in_docker_and_vice_versa()
    {
        Assert.That(LaunchPlanner.Validate(new LaunchPlan(Method.Docker, Method.Docker, Method.Script)).Ok, Is.False);
        Assert.That(LaunchPlanner.Validate(new LaunchPlan(Method.Docker, Method.Script, Method.Docker)).Ok, Is.False);
        Assert.That(LaunchPlanner.Validate(LaunchPlan.AllDocker).Ok, Is.True);
    }

    [Test]
    public void Backend_needs_the_database()
    {
        var problems = LaunchPlanner.Validate(new LaunchPlan(Method.Off, Method.Script, Method.Off));

        Assert.That(problems.Ok, Is.False);
    }

    [Test]
    public void Frontend_without_backend_is_only_a_warning()
    {
        var problems = LaunchPlanner.Validate(new LaunchPlan(Method.Docker, Method.Off, Method.Script));

        Assert.That(problems.Ok, Is.True);
        Assert.That(problems.Warnings, Is.Not.Empty);
    }

    [Test]
    public void Everything_in_docker_from_nothing_is_one_db_start_and_one_app_start()
    {
        var steps = LaunchPlanner.Steps(LaunchPlan.AllDocker, LaunchPlan.Nothing);

        Assert.That(Commands(steps), Is.EqualTo(new[] { "up db", "up app" }));
    }

    [Test]
    public void Plan_that_matches_the_current_state_has_no_steps()
    {
        Assert.That(LaunchPlanner.Steps(LaunchPlan.AllScript, LaunchPlan.AllScript), Is.Empty);
    }

    [Test]
    public void Switching_script_backend_to_ide_stops_it_then_waits_for_the_ide()
    {
        var steps = LaunchPlanner.Steps(LaunchPlan.BackendInIde, LaunchPlan.AllScript);

        Assert.That(Commands(steps), Is.EqualTo(new[] { "down be" }));
        Assert.That(steps.Last(), Is.TypeOf<WaitForIdeStep>());
    }

    [Test]
    public void Moving_from_docker_to_scripts_stops_docker_before_starting_processes()
    {
        var steps = LaunchPlanner.Steps(LaunchPlan.AllScript, LaunchPlan.AllDocker);

        Assert.That(Commands(steps), Is.EqualTo(new[] { "down app", "up be", "up fe" }));
    }

    [Test]
    public void Running_ide_backend_cannot_be_replaced_without_a_manual_stop()
    {
        var current = new LaunchPlan(Method.Docker, Method.Ide, Method.Script);

        var steps = LaunchPlanner.Steps(LaunchPlan.AllScript, current);

        Assert.That(steps.OfType<ManualStopStep>(), Is.Not.Empty);
    }

    [Test]
    public void Current_reads_who_started_each_running_part()
    {
        var snap = Stack(
            Row(ComponentKind.Database, ComponentState.Running, LauncherKind.Docker),
            Row(ComponentKind.Api, ComponentState.Running, LauncherKind.Ide),
            Row(ComponentKind.Frontend, ComponentState.Running, LauncherKind.Script),
            Row(ComponentKind.Web, ComponentState.Down, LauncherKind.Docker));

        Assert.That(LaunchPlanner.Current(snap), Is.EqualTo(new LaunchPlan(Method.Docker, Method.Ide, Method.Script)));
    }
}
