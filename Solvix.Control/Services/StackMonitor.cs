using Solvix.Control.Models;

namespace Solvix.Control.Services;

// Every few seconds, merges the three views of the stack - Docker, the OS and
// what instances report about themselves - into one list of components.
public sealed class StackMonitor(
    InstanceRegistry registry,
    DockerProbe docker,
    HostProbe host,
    ControlPaths paths,
    IConfiguration configuration,
    TimeProvider time,
    ILogger<StackMonitor> log) : BackgroundService
{
    private static readonly Launcher DockerLauncher = new(LauncherKind.Docker, "docker compose");

    public StackSnapshot Current { get; private set; } = StackSnapshot.Empty;
    public event Action? Changed;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
        do
        {
            await RefreshAsync(stoppingToken);
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        try
        {
            Current = Build(await host.CaptureAsync(ct), await docker.CaptureAsync(ct), registry.Snapshot());
            Changed?.Invoke();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogWarning(e, "Stack refresh failed");
        }
    }

    public StackSnapshot Build(HostSnapshot hostSnap, DockerSnapshot dockerSnap, IReadOnlyList<InstanceView> instances)
    {
        var scriptPids = new[] { "be", "fe", "panel" }
            .Select(paths.ReadScriptPid).Where(p => p is not null).Select(p => p!.Value).ToList();

        var rows = new List<ComponentRow>
        {
            DockerRow(dockerSnap, "postgres", "db", "Database", ComponentKind.Database,
                paths.DbPort, null, "up db", "down db", "db"),
        };
        rows.AddRange(BackendRows(hostSnap, dockerSnap, instances, scriptPids));
        rows.Add(FrontendRow(hostSnap, scriptPids));
        rows.Add(DockerRow(dockerSnap, "web", "web", "Web (docker)", ComponentKind.Web,
            paths.WebPort, $"http://localhost:{paths.WebPort}", "demo", "down app", "web"));
        rows.Add(PanelRow(hostSnap, scriptPids));

        var others = dockerSnap.Containers
            .Where(c => c.Running && c.Project != DockerProbe.Project)
            .Select(c => new ForeignContainer(c.Name, c.Image, c.Status, c.Ports))
            .ToList();

        return new StackSnapshot(time.GetUtcNow(), rows, others, dockerSnap.Available);
    }

    private ComponentRow DockerRow(
        DockerSnapshot snap, string service, string key, string name, ComponentKind kind,
        int port, string? url, string? start, string? stop, string? logSource)
    {
        var container = snap.Service(DockerProbe.Project, service);
        var state = container switch
        {
            null or { Running: false } => ComponentState.Down,
            { Healthy: true } => ComponentState.Running,
            _ => ComponentState.Unhealthy,
        };
        var detail = !snap.Available ? "docker не відповідає"
            : container is null ? "контейнера немає"
            : container.Status;
        return new ComponentRow(key, name, kind, state, DockerLauncher, detail,
            state == ComponentState.Down ? null : port, url, null, null, start, stop, logSource);
    }

    private IEnumerable<ComponentRow> BackendRows(
        HostSnapshot hostSnap, DockerSnapshot dockerSnap, IReadOnlyList<InstanceView> instances, List<int> scriptPids)
    {
        var apis = instances.Where(i => i.Info.Role == "api").ToList();
        foreach (var view in apis)
        {
            var info = view.Info;
            var launcher = LauncherOf(info, hostSnap, scriptPids);
            var down = view.Health == InstanceHealth.Unresponsive;
            yield return new ComponentRow(
                "api:" + info.Id,
                apis.Count > 1 ? $"Backend API · {info.Name}" : "Backend API",
                ComponentKind.Api,
                down ? ComponentState.Unresponsive : ComponentState.Running,
                launcher,
                $"pid {info.Pid} · {info.Environment} · v{info.Version}",
                PortOf(info.Urls),
                info.Urls.FirstOrDefault(),
                info.Pid,
                view,
                "up be",
                launcher.Kind == LauncherKind.Docker ? "down app" : "down be",
                launcher.Kind == LauncherKind.Docker ? "api" : "be");
        }

        var containerApi = dockerSnap.Service(DockerProbe.Project, "api");
        var containerReported = apis.Any(a => a.Info.Launcher == "docker");
        if (containerApi is { Running: true } && !containerReported)
        {
            // Running but not reporting: the panel is probably unreachable from the container.
            yield return new ComponentRow("api-docker", "Backend API (docker)", ComponentKind.Api,
                ComponentState.Unhealthy, DockerLauncher, "працює, але не звітує панелі · " + containerApi.Status,
                null, null, null, null, null, "down app", "api");
        }

        if (apis.Count == 0 && containerApi is not { Running: true })
        {
            if (hostSnap.ListenerOn(paths.BackendPorts) is { } pid)
            {
                yield return new ComponentRow("be", "Backend API (не зареєстрований)", ComponentKind.Api,
                    ComponentState.Running, LauncherClassifier.Classify(pid, hostSnap, scriptPids),
                    $"pid {pid} · слухає порт, але не звітує панелі", paths.BackendPorts[0], null, pid,
                    null, "up be", "down be", "be");
            }
            else
            {
                yield return new ComponentRow("be", "Backend API", ComponentKind.Api, ComponentState.Down,
                    Launcher.None, "вимкнено", null, null, null, null, "up be", "down be", "be");
            }
        }
    }

    private ComponentRow FrontendRow(HostSnapshot hostSnap, List<int> scriptPids)
    {
        if (hostSnap.ListenerOn(paths.FrontendPort) is { } pid)
        {
            return new ComponentRow("fe", "Frontend (dev)", ComponentKind.Frontend, ComponentState.Running,
                LauncherClassifier.Classify(pid, hostSnap, scriptPids), $"pid {pid}",
                paths.FrontendPort, $"http://localhost:{paths.FrontendPort}", pid, null, "up fe", "down fe", "fe");
        }
        return new ComponentRow("fe", "Frontend (dev)", ComponentKind.Frontend, ComponentState.Down,
            Launcher.None, "вимкнено", null, null, null, null, "up fe", "down fe", "fe");
    }

    private ComponentRow PanelRow(HostSnapshot hostSnap, List<int> scriptPids)
    {
        var url = configuration["Control:PublicUrl"] ?? "http://localhost:5200";
        return new ComponentRow("panel", "Панель керування", ComponentKind.Panel, ComponentState.Running,
            LauncherClassifier.Classify(Environment.ProcessId, hostSnap, scriptPids),
            $"pid {Environment.ProcessId}", PortOf([url]), url, Environment.ProcessId, null, null, null, "panel");
    }

    private static Launcher LauncherOf(InstanceRegistration info, HostSnapshot hostSnap, List<int> scriptPids) =>
        info.Launcher switch
        {
            "docker" => DockerLauncher,
            "script" => new Launcher(LauncherKind.Script, "solvix script"),
            _ when info.Host == Environment.MachineName => LauncherClassifier.Classify(info.Pid, hostSnap, scriptPids)
                is { Kind: not LauncherKind.Unknown } found ? found : new Launcher(LauncherKind.Unknown, "вручну"),
            _ => new Launcher(LauncherKind.Remote, info.Host),
        };

    private static int? PortOf(IEnumerable<string> urls) =>
        urls.Select(u => Uri.TryCreate(u.Replace("*", "localhost").Replace("+", "localhost"), UriKind.Absolute, out var uri) ? uri.Port : (int?)null)
            .FirstOrDefault(p => p is not null);
}
