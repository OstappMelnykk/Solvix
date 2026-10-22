using System.Text.Json;
using Solvix.Control.Models;

namespace Solvix.Control.Services;

// Recent log entries from every instance: a bounded in-memory ring for the UI
// plus a daily JSON-lines file, so history survives a panel restart and can be
// grepped or shipped elsewhere later.
public sealed class LogStore
{
    private const int Capacity = 20_000;
    private const int ReloadOnStart = 5_000;

    private readonly object _gate = new();
    private readonly LogEntry[] _ring = new LogEntry[Capacity];
    private int _next;
    private int _count;
    private readonly string? _directory;
    private readonly TimeProvider _time;

    public event Action? Added;

    [ActivatorUtilitiesConstructor]
    public LogStore(ControlPaths paths, TimeProvider time) : this(paths.LogDir, time) { }

    public static LogStore InMemory(TimeProvider time) => new((string?)null, time);

    public LogStore(string? directory, TimeProvider time)
    {
        _directory = directory;
        _time = time;
        if (directory is not null)
        {
            Reload();
        }
    }

    public void Add(IReadOnlyCollection<LogEntry> entries)
    {
        if (entries.Count == 0)
        {
            return;
        }
        lock (_gate)
        {
            foreach (var entry in entries)
            {
                Push(entry);
            }
            Persist(entries);
        }
        Added?.Invoke();
    }

    public IReadOnlyList<LogEntry> Query(LogFilter filter)
    {
        var minRank = LogLevels.Rank(filter.MinLevel);
        var result = new List<LogEntry>();
        lock (_gate)
        {
            // Newest first, so Take keeps the most recent matches.
            for (var i = 0; i < _count && result.Count < filter.Take; i++)
            {
                var entry = _ring[(_next - 1 - i + Capacity) % Capacity];
                if (LogLevels.Rank(entry.Level) < minRank
                    || (filter.InstanceId is { Length: > 0 } id && entry.InstanceId != id)
                    || (filter.Text is { Length: > 0 } text && !Matches(entry, text)))
                {
                    continue;
                }
                result.Add(entry);
            }
        }
        result.Reverse();
        return result;
    }

    public IReadOnlyList<string> InstanceIds()
    {
        lock (_gate)
        {
            return Enumerable.Range(0, _count)
                .Select(i => _ring[(_next - 1 - i + Capacity) % Capacity].InstanceId)
                .Distinct().Order().ToList();
        }
    }

    private static bool Matches(LogEntry entry, string text) =>
        entry.Message.Contains(text, StringComparison.OrdinalIgnoreCase)
        || entry.Category.Contains(text, StringComparison.OrdinalIgnoreCase)
        || (entry.Exception?.Contains(text, StringComparison.OrdinalIgnoreCase) ?? false);

    private void Push(LogEntry entry)
    {
        _ring[_next] = entry;
        _next = (_next + 1) % Capacity;
        _count = Math.Min(_count + 1, Capacity);
    }

    private string FileFor(DateTimeOffset day) => Path.Combine(_directory!, $"entries-{day:yyyyMMdd}.jsonl");

    private void Persist(IEnumerable<LogEntry> entries)
    {
        if (_directory is null)
        {
            return;
        }
        try
        {
            File.AppendAllLines(FileFor(_time.GetUtcNow()), entries.Select(e => JsonSerializer.Serialize(e)));
        }
        catch (IOException)
        {
            // Losing the on-disk copy must never take log ingestion down.
        }
    }

    private void Reload()
    {
        try
        {
            var latest = Directory.GetFiles(_directory!, "entries-*.jsonl").Order().LastOrDefault();
            if (latest is null)
            {
                return;
            }
            foreach (var line in File.ReadLines(latest).TakeLast(ReloadOnStart))
            {
                if (JsonSerializer.Deserialize<LogEntry>(line) is { } entry)
                {
                    Push(entry);
                }
            }
        }
        catch (Exception e) when (e is IOException or JsonException)
        {
            // A corrupt or unreadable history file just means starting empty.
        }
    }
}
