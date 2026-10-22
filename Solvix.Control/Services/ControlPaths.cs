namespace Solvix.Control.Services;

// Where the repo, the launcher script and its state directory live, plus the
// ports the stack is expected to use (read from the same .env the script uses).
public sealed class ControlPaths
{
    public string RepoRoot { get; }
    public string StateDir => Path.Combine(RepoRoot, ".solvix");
    public string LogDir => Path.Combine(StateDir, "logs");
    public string RunDir => Path.Combine(StateDir, "run");
    public string LauncherScript => Path.Combine(RepoRoot, "scripts", "solvix");

    public int DevDbPort { get; }
    public int FrontendPort => 4200;
    public int[] BackendPorts => [7153, 5168];

    public ControlPaths(IConfiguration configuration)
    {
        RepoRoot = configuration["Control:RepoRoot"] is { Length: > 0 } configured
            ? configured
            : FindRepoRoot() ?? Directory.GetCurrentDirectory();

        var env = ReadEnvFile(Path.Combine(RepoRoot, ".env"));
        DevDbPort = ParsePort(env, "DEV_DB_PORT", ParsePort(env, "DB_PORT", 5434));

        Directory.CreateDirectory(LogDir);
    }

    // pid recorded by the launcher script for a component (be / fe / panel), if any.
    public int? ReadScriptPid(string component)
    {
        var file = Path.Combine(RunDir, component + ".pid");
        return File.Exists(file) && int.TryParse(File.ReadAllText(file).Trim(), out var pid) ? pid : null;
    }

    private static string? FindRepoRoot()
    {
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "Solvix_v1.sln")))
                {
                    return dir.FullName;
                }
            }
        }
        return null;
    }

    private static Dictionary<string, string> ReadEnvFile(string path)
    {
        var result = new Dictionary<string, string>();
        if (!File.Exists(path))
        {
            return result;
        }
        foreach (var line in File.ReadLines(path))
        {
            var trimmed = line.Trim();
            var eq = trimmed.IndexOf('=');
            if (trimmed.StartsWith('#') || eq <= 0)
            {
                continue;
            }
            result[trimmed[..eq].Trim()] = trimmed[(eq + 1)..].Trim();
        }
        return result;
    }

    private static int ParsePort(Dictionary<string, string> env, string key, int fallback) =>
        env.TryGetValue(key, out var value) && int.TryParse(value, out var port) ? port : fallback;
}
