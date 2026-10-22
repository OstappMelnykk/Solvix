using Solvix.Control.Models;

namespace Solvix.Control.Services;

public sealed record ActionResult(string Title, bool Success, string Output, DateTimeOffset Finished);

// Start/stop go through ./scripts/solvix, the same code path as typing the
// command by hand - the panel never starts processes behind the script's back,
// so pid files, port checks and the action journal stay consistent.
public sealed class ActionRunner(
    ControlPaths paths,
    IProcessRunner runner,
    LogStore logs,
    TimeProvider time,
    ILogger<ActionRunner> log)
{
    public const string PanelInstanceId = "panel";

    private readonly SemaphoreSlim _one = new(1, 1);

    public bool Busy => _one.CurrentCount == 0;
    public string? CurrentTitle { get; private set; }
    public ActionResult? Last { get; private set; }
    public event Action? Changed;

    public async Task<ActionResult> RunAsync(string title, string arguments)
    {
        if (!await _one.WaitAsync(0))
        {
            return new ActionResult(title, false, "Інша дія ще виконується.", time.GetUtcNow());
        }
        try
        {
            CurrentTitle = title;
            Changed?.Invoke();
            Emit("Information", $"▶ {title}");

            var lines = new List<string>();
            var result = await runner.RunAsync(
                paths.LauncherScript,
                arguments.Split(' ', StringSplitOptions.RemoveEmptyEntries),
                TimeSpan.FromMinutes(15),
                // Keeps "down all" from stopping the panel that is asking for it.
                env: new Dictionary<string, string> { ["SOLVIX_FROM_PANEL"] = "1", ["NO_COLOR"] = "1" },
                onLine: line =>
                {
                    lock (lines) { lines.Add(line); }
                    if (!string.IsNullOrWhiteSpace(line))
                    {
                        Emit("Information", line.Trim());
                    }
                });

            string output;
            lock (lines) { output = string.Join('\n', lines); }
            Last = new ActionResult(title, result.Success, output, time.GetUtcNow());
            Emit(result.Success ? "Information" : "Error", result.Success ? $"✔ {title}" : $"✖ {title} (код {result.ExitCode})");
            if (!result.Success)
            {
                log.LogWarning("Action {Title} failed with exit code {Code}", title, result.ExitCode);
            }
            return Last;
        }
        finally
        {
            CurrentTitle = null;
            _one.Release();
            Changed?.Invoke();
        }
    }

    private void Emit(string level, string message) =>
        logs.Add([new LogEntry(time.GetUtcNow(), level, "control.action", message, null, PanelInstanceId)]);
}
