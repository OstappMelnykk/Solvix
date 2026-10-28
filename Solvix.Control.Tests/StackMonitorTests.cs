using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Solvix.Control.Models;
using Solvix.Control.Services;

namespace Solvix.Control.Tests;

public class StackMonitorTests
{
    private static StackMonitor Monitor()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Control:RepoRoot"] = Path.GetTempPath() })
            .Build();
        // Build() is pure over the snapshots it is given - the probes are never called.
        return new StackMonitor(new InstanceRegistry(TimeProvider.System), null!, null!, new ControlPaths(config),
            config, TimeProvider.System, NullLogger<StackMonitor>.Instance);
    }

    private static HostSnapshot Host(IEnumerable<(int Port, int Pid)> listeners, params (int Pid, int Parent, string Command)[] processes) =>
        new(listeners.ToDictionary(l => l.Port, l => l.Pid),
            processes.ToDictionary(p => p.Pid, p => new ProcessInfo(p.Pid, p.Parent, p.Command)));

    private static DockerContainer Container(string id, string project, string service, string status = "Up 1 minute (healthy)") =>
        new(id, $"{project}-{service}-1", service, project, "img", status.StartsWith("Up") ? "running" : "exited", status, "");

    private static DockerSnapshot Docker(params DockerContainer[] containers) => new(true, containers);

    private static InstanceView ApiInstance(string launcher, string host, int pid) =>
        new(new InstanceRegistration("api-1", "api", host, pid, launcher, host, ["http://localhost:7153"], "1.0", "Development",
            DateTimeOffset.UtcNow, null), DateTimeOffset.UtcNow, InstanceHealth.Alive, 0);

    [Test]
    public void Backend_started_from_Rider_lands_in_the_IDE_section_and_blocks_the_terminal_one()
    {
        var host = Host([(7153, 30)],
            (10, 1, "/Applications/Rider.app/Contents/MacOS/rider"), (30, 10, "dotnet Solvix.Api.dll"));

        var snap = Monitor().Build(host, Docker(), [ApiInstance(null!, Environment.MachineName, 30)]);

        Assert.That(snap.Ide.Single(s => s.Key == "be").Here, Is.Not.Null);
        Assert.That(snap.Terminal.Single(s => s.Key == "be").Here, Is.Null);
        Assert.That(snap.Terminal.Single(s => s.Key == "be").Elsewhere, Is.Not.Null);
    }

    [Test]
    public void Backend_started_by_the_script_belongs_to_the_terminal_section()
    {
        var snap = Monitor().Build(Host([]), Docker(), [ApiInstance("script", "any-host", 99)]);

        Assert.That(snap.Terminal.Single(s => s.Key == "be").Here, Is.Not.Null);
        Assert.That(snap.Ide.Single(s => s.Key == "be").Elsewhere, Is.Not.Null);
    }

    [Test]
    public void Nothing_running_leaves_every_slot_free()
    {
        var snap = Monitor().Build(Host([]), Docker(), []);

        Assert.That(snap.Ide.Concat(snap.Terminal), Has.All.Matches<Slot>(s => s.Here is null && s.Elsewhere is null));
        Assert.That(snap.Stacks, Is.Empty);
        Assert.That(snap.DevDb.IsUp, Is.False);
    }

    [Test]
    public void Each_docker_stack_gets_its_own_ports_and_database()
    {
        var snap = Monitor().Build(Host([]), Docker(
            Container("aaa111", "solvix-1", "postgres"), Container("aaa222", "solvix-1", "api"), Container("aaa333", "solvix-1", "web"),
            Container("bbb111", "solvix-3", "postgres", "Exited (0) 1 hour ago")), []);

        Assert.That(snap.Stacks.Select(s => s.Id), Is.EqualTo(new[] { 1, 3 }));
        var first = snap.Stacks[0];
        Assert.That((first.WebPort, first.ApiPort, first.DbPort, first.State), Is.EqualTo((8081, 5171, 5441, ComponentState.Running)));
        Assert.That(first.Apis.Single().Port, Is.EqualTo(5171));
        Assert.That(first.DataVolume, Is.EqualTo("solvix_stack1_postgres_data"));
        Assert.That((snap.Stacks[1].WebPort, snap.Stacks[1].DbPort), Is.EqualTo((8083, 5443)));
        Assert.That(snap.Stacks[1].State, Is.EqualTo(ComponentState.Down));
    }

    [Test]
    public void Reported_api_instance_is_matched_to_its_stack_by_container_id()
    {
        var snap = Monitor().Build(Host([]), Docker(
            Container("abc123def456", "solvix-2", "postgres"), Container("abc123def456".Replace("abc", "fff"), "solvix-2", "api"),
            Container("111111111111", "solvix-2", "web")),
            [ApiInstance("docker", "fff123def456", 1)]);

        Assert.That(snap.Stacks.Single().Apis.Single().Instance, Is.Not.Null);
        // A docker-launched api is not the host backend.
        Assert.That(snap.Ide.Concat(snap.Terminal).Select(s => s.Here), Has.All.Null);
    }

    [Test]
    public void Dev_database_and_stack_databases_are_told_apart()
    {
        var snap = Monitor().Build(Host([]), Docker(
            Container("d1", "solvix-dev", "devdb"), Container("s1", "solvix-1", "postgres")), []);

        Assert.That(snap.DevDb.IsUp, Is.True);
        Assert.That(snap.Stacks.Single().Db.IsUp, Is.True);
        Assert.That(snap.OtherContainers, Is.Empty);
    }
}
