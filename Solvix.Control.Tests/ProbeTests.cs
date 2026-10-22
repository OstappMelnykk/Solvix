using Solvix.Control.Models;
using Solvix.Control.Services;

namespace Solvix.Control.Tests;

public class ProbeTests
{
    [Test]
    public void Lsof_output_maps_ports_to_pids()
    {
        var listeners = HostProbe.ParseListeners("p100\nn*:4200\nn[::1]:4200\np200\nnlocalhost:7153\nn127.0.0.1:5168\n");

        Assert.That(listeners[4200], Is.EqualTo(100));
        Assert.That(listeners[7153], Is.EqualTo(200));
        Assert.That(listeners[5168], Is.EqualTo(200));
    }

    private static HostSnapshot Host(params (int Pid, int Parent, string Command)[] processes) =>
        new(new Dictionary<int, int>(), processes.ToDictionary(p => p.Pid, p => new ProcessInfo(p.Pid, p.Parent, p.Command)));

    [Test]
    public void Process_started_under_Rider_is_attributed_to_the_IDE()
    {
        var host = Host(
            (10, 1, "/Applications/Rider.app/Contents/MacOS/rider"),
            (20, 10, "dotnet exec Solvix.Api.dll"),
            (30, 20, "Solvix.Api"));

        var launcher = LauncherClassifier.Classify(30, host, []);

        Assert.That(launcher, Is.EqualTo(new Launcher(LauncherKind.Ide, "Rider")));
    }

    [Test]
    public void Process_under_a_recorded_script_pid_is_attributed_to_the_script_even_inside_an_IDE_terminal()
    {
        var host = Host(
            (10, 1, "/Applications/WebStorm.app/Contents/MacOS/webstorm"),
            (20, 10, "-zsh"),
            (30, 1, "npm start"),
            (40, 30, "node ng serve"));

        var launcher = LauncherClassifier.Classify(40, host, [30]);

        Assert.That(launcher.Kind, Is.EqualTo(LauncherKind.Script));
    }

    [Test]
    public void Process_with_only_a_shell_above_it_is_a_terminal_launch()
    {
        var host = Host((10, 1, "-zsh"), (20, 10, "node ng serve"));

        Assert.That(LauncherClassifier.Classify(20, host, []).Kind, Is.EqualTo(LauncherKind.Terminal));
    }

    [Test]
    public void Docker_listing_parses_compose_labels_and_health()
    {
        const string line = """{"Names":"solvix-api-1","Image":"solvix-api","State":"running","Status":"Up 3 minutes (healthy)","Ports":"","Labels":"com.docker.compose.project=solvix,com.docker.compose.service=api"}""";

        var container = DockerProbe.ParseContainers(line + "\nnot json\n").Single();

        Assert.That(container.Project, Is.EqualTo("solvix"));
        Assert.That(container.Service, Is.EqualTo("api"));
        Assert.That(container.Healthy, Is.True);
    }

    [Test]
    public void Container_that_is_still_starting_is_not_healthy()
    {
        var container = new DockerContainer("n", "web", "solvix", "i", "running", "Up 2 seconds (health: starting)", "");

        Assert.That(container.Healthy, Is.False);
    }
}
