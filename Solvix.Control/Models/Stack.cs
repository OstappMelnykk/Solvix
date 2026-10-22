namespace Solvix.Control.Models;

public enum ComponentKind { Database, Api, Web, Frontend, Panel }

public enum ComponentState { Running, Down, Unresponsive, Unhealthy }

// How a process was started. Ide and Terminal sections are told apart by this.
public enum LauncherKind { Docker, Script, Ide, Terminal, Remote, Unknown }

public sealed record Launcher(LauncherKind Kind, string Name)
{
    public static readonly Launcher None = new(LauncherKind.Unknown, "невідомо");
}

// A single thing that is running (or not). Carries no actions: start/stop live
// once per section, in the UI, not on every row.
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
    string? LogSource = null,
    string? PortNote = null)
{
    public bool IsUp => State != ComponentState.Down;
}

public enum Section { Ide, Terminal }

// The backend or frontend "slot": one port that only one process can hold.
// Here = the process on it, if it belongs to the section being drawn;
// Elsewhere = a process of the other section occupying the same port.
public sealed record Slot(string Key, string Name, int Port, ComponentRow? Here, ComponentRow? Elsewhere);

// One isolated Docker environment: its own database, api and web.
public sealed record DockerStack(
    int Id,
    int WebPort,
    int ApiPort,
    int DbPort,
    ComponentState State,
    ComponentRow Db,
    IReadOnlyList<ComponentRow> Apis,
    ComponentRow Web,
    string DataVolume);

public sealed record ForeignContainer(string Name, string Image, string Status, string Ports);

public sealed record StackSnapshot(
    DateTimeOffset Time,
    ComponentRow DevDb,
    IReadOnlyList<Slot> Ide,
    IReadOnlyList<Slot> Terminal,
    IReadOnlyList<DockerStack> Stacks,
    ComponentRow Panel,
    IReadOnlyList<ForeignContainer> OtherContainers,
    bool DockerAvailable)
{
    private static readonly ComponentRow Nothing = new("-", "-", ComponentKind.Database, ComponentState.Down, Launcher.None, "");
    public static readonly StackSnapshot Empty = new(DateTimeOffset.MinValue, Nothing, [], [], [], Nothing, [], true);
}
