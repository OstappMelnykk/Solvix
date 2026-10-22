using Solvix.Control.Models;

namespace Solvix.Control.Services;

public enum TermKind { Command, Output, Error, Info }

public sealed record TermLine(TermKind Kind, string Text);

public sealed record ParsedCommand(string File, IReadOnlyList<string> Args);

// The panel's command line: a read-only window onto the machine. The input is
// split into words (quotes respected) and handed to CommandPolicy, which decides
// whether that program with those arguments may run; it is never given to a shell.
public sealed class TerminalService(
    ControlPaths paths,
    CommandPolicy policy,
    IProcessRunner runner,
    TimeProvider time,
    ILogger<TerminalService> log)
{
    private const int MaxLines = 5_000;

    private readonly object _gate = new();
    private readonly List<TermLine> _lines = [];
    private readonly List<string> _history = [];
    private CancellationTokenSource? _running;

    public bool Busy => _running is not null;
    public event Action? Changed;

    public IReadOnlyList<TermLine> Lines { get { lock (_gate) { return _lines.ToList(); } } }
    public IReadOnlyList<string> History { get { lock (_gate) { return _history.ToList(); } } }

    public static IReadOnlyList<string> Tokenize(string line)
    {
        var tokens = new List<string>();
        var current = new System.Text.StringBuilder();
        char? quote = null;
        var inToken = false;
        foreach (var c in line)
        {
            if (quote is not null)
            {
                if (c == quote) { quote = null; } else { current.Append(c); }
            }
            else if (c is '"' or '\'')
            {
                quote = c;
                inToken = true;
            }
            else if (char.IsWhiteSpace(c))
            {
                if (inToken) { tokens.Add(current.ToString()); current.Clear(); inToken = false; }
            }
            else
            {
                current.Append(c);
                inToken = true;
            }
        }
        if (inToken) { tokens.Add(current.ToString()); }
        return tokens;
    }

    // Returns null and the reason when the command isn't allowed.
    public ParsedCommand? Parse(string line, out string? error)
    {
        var decision = policy.Evaluate(Tokenize(line));
        error = decision.Reason;
        return decision.Command;
    }

    public async Task RunAsync(string line)
    {
        line = line.Trim();
        if (line.Length == 0)
        {
            return;
        }
        var cts = new CancellationTokenSource();
        lock (_gate)
        {
            if (_running is not null)
            {
                Append(TermKind.Info, "Попередня команда ще виконується. Зупини її або дочекайся.");
                Raise();
                return;
            }
            _running = cts;
            if (_history.LastOrDefault() != line) { _history.Add(line); }
            Append(TermKind.Command, line);
        }

        if (line == "help")
        {
            foreach (var text in CommandPolicy.Help.Split('\n')) { Append(TermKind.Info, text); }
            Finish(cts);
            return;
        }

        var parsed = Parse(line, out var error);
        if (parsed is null)
        {
            Append(TermKind.Error, error!);
            Append(TermKind.Info, "help - що дозволено.");
            Finish(cts);
            return;
        }

        Raise();
        try
        {
            var result = await runner.RunAsync(
                parsed.File, parsed.Args, TimeSpan.FromMinutes(15),
                // The terminal must not be able to stop the panel it lives in.
                env: new Dictionary<string, string>
                {
                    ["SOLVIX_KEEP_PANEL"] = "1",
                    ["NO_COLOR"] = "1",
                    ["GIT_PAGER"] = "cat",
                    ["GIT_OPTIONAL_LOCKS"] = "0",
                },
                onLine: text => { Append(TermKind.Output, text); Raise(); },
                ct: cts.Token,
                workingDirectory: paths.RepoRoot);
            Append(result.Success ? TermKind.Info : TermKind.Error,
                result.ExitCode == -2 ? "перервано" : $"exit {result.ExitCode}");
            if (result.ExitCode == -1)
            {
                Append(TermKind.Error, result.Error);
            }
        }
        catch (Exception e)
        {
            log.LogWarning(e, "Terminal command failed: {Line}", line);
            Append(TermKind.Error, e.Message);
        }
        finally
        {
            Finish(cts);
        }
    }

    public void Cancel()
    {
        lock (_gate) { _running?.Cancel(); }
    }

    public void Clear()
    {
        lock (_gate) { _lines.Clear(); }
        Raise();
    }

    private void Finish(CancellationTokenSource cts)
    {
        lock (_gate) { _running = null; }
        cts.Dispose();
        Raise();
    }

    private void Append(TermKind kind, string text)
    {
        lock (_gate)
        {
            _lines.Add(new TermLine(kind, text));
            if (_lines.Count > MaxLines)
            {
                _lines.RemoveRange(0, _lines.Count - MaxLines);
            }
        }
    }

    private void Raise() => Changed?.Invoke();
}
