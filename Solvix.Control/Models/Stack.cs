namespace Solvix.Control.Models;

public enum ComponentKind { Database, Api, Web, Frontend, Panel }

public enum ComponentState { Running, Down, Unresponsive, Unhealthy }

// How a component was started. Ide/Terminal/Unknown can't be stopped from the
// panel - that would fight whatever started them.
public enum LauncherKind { Docker, Script, Ide, Terminal, Remote, Unknown }

public sealed record Launcher(LauncherKind Kind, string Name)
{
    public static readonly Launcher None = new(LauncherKind.Unknown, "невідомо");
}

public sealed record ComponentRow(
    string Key,
    string Name,
    ComponentKind Kind,
    ComponentState State,
    Launcher Launcher,
    string Detail,
    int? Port = null,
    string? Url = null,
    int? Pid = null,
    InstanceView? Instance = null,
    string? StartAction = null,
    string? StopAction = null,
    string? LogSource = null)
{
    public bool CanStop => State != ComponentState.Down && StopAction is not null
        && Launcher.Kind is LauncherKind.Docker or LauncherKind.Script;
    public bool CanStart => State == ComponentState.Down && StartAction is not null;
}

public sealed record ForeignContainer(string Name, string Image, string Status, string Ports);

public sealed record StackSnapshot(
    DateTimeOffset Time,
    IReadOnlyList<ComponentRow> Components,
    IReadOnlyList<ForeignContainer> OtherContainers,
    bool DockerAvailable)
{
    public static readonly StackSnapshot Empty = new(DateTimeOffset.MinValue, [], [], true);
}
