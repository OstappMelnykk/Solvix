namespace Solvix.Control.Services;

public sealed record PolicyDecision(bool Allowed, string? Reason, ParsedCommand? Command)
{
    public static PolicyDecision Allow(string file, IEnumerable<string> args) => new(true, null, new ParsedCommand(file, args.ToList()));
    public static PolicyDecision Deny(string reason) => new(false, reason, null);
}

// What the panel's terminal may run. The terminal is a read-only window onto
// the machine: look at containers, processes, ports, logs, git state. Anything
// that writes, deletes, installs or opens a shell is refused. The input is never
// given to a shell, so there is no `;`, pipe or `$(...)` to smuggle things in;
// this policy decides which program and which arguments are acceptable.
public sealed class CommandPolicy
{
    private readonly string _repoRoot;
    private readonly string _launcherScript;
    private readonly string[] _readableRoots;

    public CommandPolicy(ControlPaths paths)
    {
        _repoRoot = paths.RepoRoot;
        _launcherScript = paths.LauncherScript;
        // Files can be read inside the repository and in the usual scratch/log places only.
        _readableRoots = [_repoRoot, "/tmp", "/private/tmp", "/var/log", "/private/var/log"];
    }

    public static string Help => """
        Дозволено лише читання й перевірка:
          docker   ps, images, logs, inspect, stats, top, port, info, version, volume|network|image ls|inspect, system df,
                   compose ls|ps|logs|config|top|images|port
          solvix   status, doctor, logs, help, up, down, demo, stack new|up|stop|ls   (не reset і не stack rm)
          git      status, log, diff, show, branch, remote -v, rev-parse, ls-files, blame, describe
          файли    ls, cat, head, tail, wc, grep, find, file, stat, du  (лише в теці проєкту, /tmp, /var/log)
          система  ps, lsof, uptime, whoami, hostname, date, uname, pwd, df, netstat, ifconfig -a, ping -c N
          мережа   curl (лише GET на localhost / host.docker.internal)
          інше     dotnet --info|--version|--list-sdks, colima status|list, node -v, npm -v
        """;

    public PolicyDecision Evaluate(IReadOnlyList<string> tokens)
    {
        if (tokens.Count == 0)
        {
            return PolicyDecision.Deny("Порожня команда.");
        }
        var program = tokens[0];
        var args = tokens.Skip(1).ToList();

        if (Path.GetFileName(program) == "solvix" && (program == "solvix" || Path.GetFullPath(program, _repoRoot) == _launcherScript))
        {
            return Check(Solvix(args), _launcherScript, args);
        }
        // Only bare names, resolved through PATH: a path to some other binary is never run.
        if (program.Contains('/'))
        {
            return PolicyDecision.Deny("Шлях до програми не дозволено, лише назву (наприклад docker, ls).");
        }

        var verdict = program switch
        {
            "docker" => Docker(args),
            "git" => Git(args),
            "ls" or "cat" or "head" or "tail" or "wc" or "file" or "stat" or "du" => Files(args, grepLike: false),
            "grep" => Files(args, grepLike: true),
            "find" => Find(args),
            "ps" or "lsof" or "uptime" or "whoami" or "pwd" or "uname" or "netstat" or "which" or "id" or "sw_vers" or "vm_stat" => null,
            "df" => Files(args, grepLike: false),
            "date" => args.Any(a => a is "-s" or "--set" || a.StartsWith("--set=")) ? "date не може змінювати час." : null,
            "hostname" => args.Any(a => !a.StartsWith('-')) ? "hostname не може змінювати ім'я." : null,
            "ifconfig" => args.All(a => a is "-a" or "-l" or "-u") ? null : "Дозволено лише ifconfig -a.",
            "ping" => Ping(args),
            "curl" => Curl(args),
            "dotnet" => args is ["--info"] or ["--version"] or ["--list-sdks"] or ["--list-runtimes"] ? null : "Дозволено лише dotnet --info | --version | --list-sdks | --list-runtimes.",
            "colima" => args is ["status"] or ["list"] or ["version"] ? null : "Дозволено лише colima status | list | version.",
            "node" or "npm" => args is ["-v"] or ["--version"] ? null : $"Дозволено лише {program} -v.",
            _ => $"Команду '{program}' не дозволено.",
        };
        return Check(verdict, program, args);
    }

    private static PolicyDecision Check(string? deniedReason, string file, IReadOnlyList<string> args) =>
        deniedReason is null ? PolicyDecision.Allow(file, args) : PolicyDecision.Deny(deniedReason);

    // --- docker ----------------------------------------------------------------

    private static readonly HashSet<string> DockerRead =
        ["ps", "images", "logs", "inspect", "stats", "top", "port", "info", "version", "diff", "history"];
    private static readonly HashSet<string> DockerReadNested = ["ls", "ps", "inspect", "list", "logs", "top", "stats", "df"];
    private static readonly HashSet<string> DockerComposeRead = ["ls", "ps", "logs", "config", "top", "images", "port", "version", "ps"];

    private static string? Docker(List<string> args)
    {
        if (args.Count == 0) { return "Вкажи підкоманду: docker ps"; }
        // Docker accepts global options (e.g. `docker -H tcp://…`) before the subcommand; pointing it at another host is not allowed.
        if (args[0].StartsWith('-')) { return "Глобальні опції docker не дозволено - починай з підкоманди (docker ps)."; }
        var sub = args[0];
        if (DockerRead.Contains(sub))
        {
            return sub == "stats" && !args.Contains("--no-stream") ? "docker stats потрібен з --no-stream." : null;
        }
        switch (sub)
        {
            case "container" or "volume" or "network" or "image" or "system" or "context":
                return args.Count >= 2 && DockerReadNested.Contains(args[1])
                    ? (sub == "system" && args[1] != "df" ? "Дозволено лише docker system df." : null)
                    : $"docker {sub}: дозволено лише перегляд (ls, inspect).";
            case "compose":
                // `docker compose -p solvix-1 ps` - skip project/file options to find the real subcommand.
                var i = 1;
                while (i < args.Count && args[i].StartsWith('-'))
                {
                    i += args[i] is "-p" or "--project-name" or "-f" or "--file" or "--profile" or "--project-directory" ? 2 : 1;
                }
                return i < args.Count && DockerComposeRead.Contains(args[i]) ? null : "docker compose: дозволено лише ls, ps, logs, config, top, images, port.";
            default:
                return $"docker {sub} змінює стан - це робиться кнопками панелі або командою solvix.";
        }
    }

    // --- solvix ----------------------------------------------------------------

    private static string? Solvix(List<string> args)
    {
        var first = args.FirstOrDefault() ?? "status";
        return first switch
        {
            "status" or "ps" or "doctor" or "logs" or "help" or "up" or "start" or "down" or "stop" or "demo" => null,
            "stack" => args.ElementAtOrDefault(1) is "new" or "up" or "stop" or "ls" or null
                ? null
                : "stack rm видаляє дані - використовуй кнопку «Видалити» в панелі (з підтвердженням).",
            "reset" => "reset видаляє всі дані - не з терміналу.",
            _ => $"solvix {first}: не дозволено в терміналі панелі.",
        };
    }

    // --- git -------------------------------------------------------------------

    private static readonly HashSet<string> GitRead =
        ["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame", "describe", "shortlog", "tag", "stash"];

    private static string? Git(List<string> args)
    {
        if (args.Count == 0 || args[0].StartsWith('-') || !GitRead.Contains(args[0]))
        {
            return "git: дозволено лише status, log, diff, show, branch, remote -v, rev-parse, ls-files, blame, describe.";
        }
        // Options that write files, run external programs, or reconfigure git.
        if (args.Any(a => a.StartsWith("--output") || a is "--ext-diff" or "--textconv" || a.StartsWith("--exec") || a == "-c" || a.StartsWith("--git-dir") || a.StartsWith("--work-tree")))
        {
            return "Ця опція git не дозволена.";
        }
        return args[0] switch
        {
            "branch" => args.Skip(1).All(a => a is "-a" or "-r" or "-v" or "-vv" or "--list" or "--show-current" or "--all" or "--remotes" or "-l")
                ? null : "git branch: лише перегляд (-a, -r, -v, --show-current).",
            "remote" => args.Skip(1).All(a => a is "-v" or "--verbose" or "show" or "get-url") ? null : "git remote: лише -v.",
            "tag" => args.Skip(1).All(a => a is "-l" or "--list" or "-n") || args.Count == 1 ? null : "git tag: лише перегляд (-l).",
            "stash" => args.ElementAtOrDefault(1) is "list" or "show" ? null : "git stash: лише list | show.",
            _ => null,
        };
    }

    // --- файли -----------------------------------------------------------------

    private static readonly string[] SecretSegments = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".npmrc", ".netrc", "id_rsa", "id_ed25519"];

    private string? Files(List<string> args, bool grepLike)
    {
        var patternSkipped = !grepLike;   // grep's first non-flag argument is a pattern, not a path
        foreach (var arg in args)
        {
            if (arg.StartsWith('-'))
            {
                if (grepLike && (arg is "-f" || arg.StartsWith("--file") || arg.StartsWith("--exclude-from")))
                {
                    return "grep -f читає файл-шаблон; не дозволено.";
                }
                continue;
            }
            if (!patternSkipped) { patternSkipped = true; continue; }
            if (PathProblem(arg) is { } problem) { return problem; }
        }
        return null;
    }

    private string? Find(List<string> args)
    {
        var banned = new[] { "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls" };
        if (args.Any(banned.Contains)) { return "find: -exec/-delete та запис у файл не дозволені."; }
        // Paths are the leading arguments, up to the first expression.
        foreach (var arg in args.TakeWhile(a => !a.StartsWith('-') && a != "(" && a != "!"))
        {
            if (PathProblem(arg) is { } problem) { return problem; }
        }
        return null;
    }

    private string? PathProblem(string arg)
    {
        string full;
        try { full = Path.GetFullPath(arg, _repoRoot); }
        catch (ArgumentException) { return $"Некоректний шлях: {arg}"; }

        // A symlink inside the repo must not lead out of the allowed places.
        var resolved = full;
        try { resolved = new FileInfo(full).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? full; }
        catch (IOException) { }

        foreach (var candidate in new[] { full, resolved })
        {
            if (!_readableRoots.Any(root => candidate == root || candidate.StartsWith(root.TrimEnd('/') + "/")))
            {
                return $"Читати можна лише в теці проєкту, /tmp і /var/log (отримано {arg}).";
            }
            var segments = candidate.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Any(s => SecretSegments.Contains(s) || s.StartsWith(".env")))
            {
                return $"Цей шлях може містити секрети, не дозволено ({arg}).";
            }
        }
        return null;
    }

    // --- мережа ----------------------------------------------------------------

    private static string? Ping(List<string> args)
    {
        var i = args.IndexOf("-c");
        return i >= 0 && i + 1 < args.Count && int.TryParse(args[i + 1], out var count) && count is >= 1 and <= 10
            ? null : "ping лише з лічильником: ping -c 3 localhost";
    }

    private static readonly HashSet<string> CurlAllowedHosts = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"];

    private static string? Curl(List<string> args)
    {
        string? url = null;
        for (var i = 0; i < args.Count; i++)
        {
            var a = args[i];
            if (a is "-X" or "--request")
            {
                if (args.ElementAtOrDefault(i + 1) is not ("GET" or "HEAD")) { return "curl: лише GET/HEAD."; }
                i++;
                continue;
            }
            if (a is "-d" or "--data" or "-F" or "--form" or "-T" or "--upload-file" or "-o" or "--output" or "-O" or "--remote-name"
                or "-K" or "--config" or "-L" or "--location" or "--json" or "-u" or "--user" or "-H" or "--header"
                || a.StartsWith("--data") || a.StartsWith("--output") || a.StartsWith("--upload"))
            {
                return $"curl: опція {a} не дозволена (лише читання, без запису у файл).";
            }
            if (!a.StartsWith('-')) { url = a; }
        }
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")
            || !CurlAllowedHosts.Contains(uri.Host))
        {
            return "curl: лише http(s)://localhost, 127.0.0.1 або host.docker.internal.";
        }
        return null;
    }
}
