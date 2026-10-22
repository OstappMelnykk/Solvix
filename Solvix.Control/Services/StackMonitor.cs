using Solvix.Control.Models;

namespace Solvix.Control.Services;

// Every few seconds, merges the three views of the stack - Docker, the OS and
// what instances report about themselves - into the sections the UI draws:
// the shared dev database, IDE, terminal, and the isolated Docker environments.
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

        // Backend and frontend each hold one host port, so at most one process
        // - from the IDE or from a terminal - can be "the" backend/frontend.
        var backend = HostBackend(hostSnap, instances, scriptPids);
        var frontend = HostFrontend(hostSnap, scriptPids);

        var others = dockerSnap.Containers
            .Where(c => c.Running && c.Project != DockerProbe.DevProject && DockerProbe.StackIdOf(c.Project) is null)
            .Select(c => new ForeignContainer(c.Name, c.Image, c.Status, c.Ports))
            .ToList();

        return new StackSnapshot(
            time.GetUtcNow(),
            DevDbRow(dockerSnap),
            SlotsFor(Section.Ide, backend, frontend),
            SlotsFor(Section.Terminal, backend, frontend),
            dockerSnap.StackIds().Select(id => StackOf(id, dockerSnap, instances)).ToList(),
            PanelRow(hostSnap, scriptPids),
            others,
            dockerSnap.Available);
    }

    // --- host processes ------------------------------------------------------

    private ComponentRow? HostBackend(HostSnapshot hostSnap, IReadOnlyList<InstanceView> instances, List<int> scriptPids)
    {
        var view = instances.FirstOrDefault(i => i.Info.Role == "api" && i.Info.Launcher != "docker");
        if (view is not null)
        {
            var info = view.Info;
            return new ComponentRow("be", "Backend API", ComponentKind.Api,
                view.Health == InstanceHealth.Alive ? ComponentState.Running : ComponentState.Unresponsive,
                LauncherOf(info, hostSnap, scriptPids),
                $"pid {info.Pid} · {info.Environment} · v{info.Version}",
                PortOf(info.Urls), info.Urls.FirstOrDefault(), info.Pid, view, "be");
        }
        if (hostSnap.ListenerOn(paths.BackendPorts) is { } pid)
        {
            return new ComponentRow("be", "Backend API", ComponentKind.Api, ComponentState.Running,
                LauncherClassifier.Classify(pid, hostSnap, scriptPids),
                $"pid {pid} · слухає порт, але не звітує панелі", paths.BackendPorts[0],
                hostSnap.Listeners.ContainsKey(paths.BackendPorts[0]) ? $"https://localhost:{paths.BackendPorts[0]}" : $"http://localhost:{paths.BackendPorts[1]}",
                pid, null, "be");
        }
        return null;
    }

    private ComponentRow? HostFrontend(HostSnapshot hostSnap, List<int> scriptPids) =>
        hostSnap.ListenerOn(paths.FrontendPort) is { } pid
            ? new ComponentRow("fe", "Frontend", ComponentKind.Frontend, ComponentState.Running,
                LauncherClassifier.Classify(pid, hostSnap, scriptPids), $"pid {pid}",
                paths.FrontendPort, $"http://localhost:{paths.FrontendPort}", pid, null, "fe")
            : null;

    // IDE gets what the IDE started; everything else on the host (script, plain
    // terminal, unknown) counts as the terminal's.
    private static bool BelongsTo(Section section, ComponentRow row) =>
        (row.Launcher.Kind == LauncherKind.Ide) == (section == Section.Ide);

    private IReadOnlyList<Slot> SlotsFor(Section section, ComponentRow? backend, ComponentRow? frontend) =>
    [
        MakeSlot(section, "be", "Backend", paths.BackendPorts[0], backend),
        MakeSlot(section, "fe", "Frontend", paths.FrontendPort, frontend),
    ];

    private static Slot MakeSlot(Section section, string key, string name, int port, ComponentRow? occupant) =>
        occupant is null ? new Slot(key, name, port, null, null)
        : BelongsTo(section, occupant) ? new Slot(key, name, port, occupant, null)
        : new Slot(key, name, port, null, occupant);

    // --- docker --------------------------------------------------------------

    private ComponentRow DevDbRow(DockerSnapshot snap) =>
        ContainerRow(snap, snap.Service(DockerProbe.DevProject, "devdb"), "db", "Спільна база", ComponentKind.Database,
            paths.DevDbPort, null, "devdb");

    private DockerStack StackOf(int id, DockerSnapshot snap, IReadOnlyList<InstanceView> instances)
    {
        var project = DockerProbe.StackProject(id);
        var web = 8080 + id;
        var api = 5170 + id;
        var db = 5440 + id;
        var dbRow = ContainerRow(snap, snap.Service(project, "postgres"), $"st{id}-db", "База", ComponentKind.Database, db, null, $"stack:{id}:postgres", "→ 5432 у контейнері");
        var webRow = ContainerRow(snap, snap.Service(project, "web"), $"st{id}-web", "Web", ComponentKind.Web, web, $"http://localhost:{web}", $"stack:{id}:web", "→ 80 у контейнері");

        // API replicas of this environment: the ones that reported in (hostname = container id) …
        var apiContainer = snap.Service(project, "api");
        var reported = instances
            .Where(i => i.Info.Launcher == "docker" && apiContainer is not null
                && (apiContainer.Id.StartsWith(i.Info.Host) || i.Info.Host.StartsWith(apiContainer.Id)))
            .Select(view => new ComponentRow($"st{id}-api", "Backend API", ComponentKind.Api,
                view.Health == InstanceHealth.Alive ? ComponentState.Running : ComponentState.Unresponsive,
                DockerLauncher, $"{view.Info.Environment} · v{view.Info.Version}", api, $"http://localhost:{api}", view.Info.Pid, view, $"stack:{id}:api", "→ 8080 у контейнері"))
            .ToList();
        // … or, if none did (panel unreachable from the container), what Docker itself knows.
        if (reported.Count == 0)
        {
            reported.Add(ContainerRow(snap, apiContainer, $"st{id}-api", "Backend API", ComponentKind.Api, api, $"http://localhost:{api}", $"stack:{id}:api", "→ 8080 у контейнері"));
        }

        var all = new[] { dbRow, webRow }.Concat(reported).ToList();
        var state = all.All(r => r.State == ComponentState.Running) ? ComponentState.Running
            : all.All(r => r.State == ComponentState.Down) ? ComponentState.Down
            : ComponentState.Unhealthy;
        return new DockerStack(id, web, api, db, state, dbRow, reported, webRow, $"solvix_stack{id}_postgres_data");
    }

    private ComponentRow ContainerRow(
        DockerSnapshot snap, DockerContainer? container, string key, string name, ComponentKind kind,
        int port, string? url, string logSource, string? portNote = null)
    {
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
            state == ComponentState.Down || port == 0 ? null : port, url, null, null, logSource, portNote);
    }

    private ComponentRow PanelRow(HostSnapshot hostSnap, List<int> scriptPids)
    {
        var url = configuration["Control:PublicUrl"] ?? "http://localhost:5200";
        return new ComponentRow("panel", "Панель керування", ComponentKind.Panel, ComponentState.Running,
            LauncherClassifier.Classify(Environment.ProcessId, hostSnap, scriptPids),
            $"pid {Environment.ProcessId}", PortOf([url]), url, Environment.ProcessId, null, "panel");
    }

    private static Launcher LauncherOf(InstanceRegistration info, HostSnapshot hostSnap, List<int> scriptPids) =>
        info.Launcher switch
        {
            "script" => new Launcher(LauncherKind.Script, "solvix script"),
            _ when info.Host == Environment.MachineName => LauncherClassifier.Classify(info.Pid, hostSnap, scriptPids)
                is { Kind: not LauncherKind.Unknown } found ? found : new Launcher(LauncherKind.Terminal, "вручну"),
            _ => new Launcher(LauncherKind.Remote, info.Host),
        };

    private static int? PortOf(IEnumerable<string> urls) =>
        urls.Select(u => Uri.TryCreate(u.Replace("*", "localhost").Replace("+", "localhost"), UriKind.Absolute, out var uri) ? uri.Port : (int?)null)
            .FirstOrDefault(p => p is not null);
}
