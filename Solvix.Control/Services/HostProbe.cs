using System.Text.RegularExpressions;
using Solvix.Control.Models;

namespace Solvix.Control.Services;

public sealed record ProcessInfo(int Pid, int ParentPid, string Command);

// What is listening and who started it, as seen from the OS (lsof + ps).
public sealed class HostSnapshot(
    IReadOnlyDictionary<int, int> listeners,
    IReadOnlyDictionary<int, ProcessInfo> processes)
{
    public static readonly HostSnapshot Empty = new(new Dictionary<int, int>(), new Dictionary<int, ProcessInfo>());

    // port -> pid of the process listening on it
    public IReadOnlyDictionary<int, int> Listeners { get; } = listeners;
    public IReadOnlyDictionary<int, ProcessInfo> Processes { get; } = processes;

    public int? ListenerOn(params int[] ports) =>
        ports.Select(p => Listeners.TryGetValue(p, out var pid) ? (int?)pid : null).FirstOrDefault(p => p is not null);

    public IEnumerable<ProcessInfo> Ancestry(int pid)
    {
        for (var depth = 0; depth < 30 && Processes.TryGetValue(pid, out var process); depth++)
        {
            yield return process;
            if (process.ParentPid <= 1)
            {
                yield break;
            }
            pid = process.ParentPid;
        }
    }
}

public sealed partial class HostProbe(IProcessRunner runner)
{
    public async Task<HostSnapshot> CaptureAsync(CancellationToken ct = default)
    {
        var lsof = await runner.RunAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], TimeSpan.FromSeconds(5), ct: ct);
        var ps = await runner.RunAsync("ps", ["-axo", "pid=,ppid=,command="], TimeSpan.FromSeconds(5), ct: ct);
        return new HostSnapshot(ParseListeners(lsof.Output), ParseProcesses(ps.Output));
    }

    // lsof -Fpn: a "p<pid>" line, then one "n<address>" line per socket of that process.
    public static Dictionary<int, int> ParseListeners(string lsofOutput)
    {
        var result = new Dictionary<int, int>();
        var pid = 0;
        foreach (var line in lsofOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line[0] == 'p' && int.TryParse(line.AsSpan(1), out var parsed))
            {
                pid = parsed;
            }
            else if (line[0] == 'n' && pid != 0
                && int.TryParse(line[(line.LastIndexOf(':') + 1)..], out var port))
            {
                result.TryAdd(port, pid);
            }
        }
        return result;
    }

    public static Dictionary<int, ProcessInfo> ParseProcesses(string psOutput)
    {
        var result = new Dictionary<int, ProcessInfo>();
        foreach (var line in psOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (ProcessLine().Match(line) is { Success: true } m)
            {
                var pid = int.Parse(m.Groups[1].Value);
                result[pid] = new ProcessInfo(pid, int.Parse(m.Groups[2].Value), m.Groups[3].Value);
            }
        }
        return result;
    }

    [GeneratedRegex(@"^\s*(\d+)\s+(\d+)\s+(.*)$")]
    private static partial Regex ProcessLine();
}

// Decides who started a process by walking up its parent chain.
public static class LauncherClassifier
{
    private static readonly (string Needle, string Name)[] Ides =
    [
        ("rider", "Rider"),
        ("webstorm", "WebStorm"),
        ("intellij", "IntelliJ IDEA"),
        ("pycharm", "PyCharm"),
        ("visual studio code", "VS Code"),
        ("code helper", "VS Code"),
        ("cursor.app", "Cursor"),
        ("devenv", "Visual Studio"),
        ("visual studio.app", "Visual Studio"),
    ];

    private static readonly string[] Terminals = ["terminal.app", "iterm", "warp", "alacritty", "kitty", "ghostty"];

    // scriptPids: pids that ./scripts/solvix recorded in .solvix/run - a process
    // underneath one of them was started by the script.
    public static Launcher Classify(int pid, HostSnapshot host, IReadOnlyCollection<int> scriptPids)
    {
        var chain = host.Ancestry(pid).ToList();
        if (chain.Any(p => scriptPids.Contains(p.Pid)))
        {
            return new Launcher(LauncherKind.Script, "solvix script");
        }
        foreach (var process in chain)
        {
            var command = process.Command.ToLowerInvariant();
            foreach (var (needle, name) in Ides)
            {
                if (command.Contains(needle))
                {
                    return new Launcher(LauncherKind.Ide, name);
                }
            }
        }
        foreach (var process in chain)
        {
            var command = process.Command.ToLowerInvariant();
            if (Terminals.Any(command.Contains) || command.StartsWith("-zsh") || command.StartsWith("-bash"))
            {
                return new Launcher(LauncherKind.Terminal, "terminal");
            }
        }
        return Launcher.None;
    }
}
