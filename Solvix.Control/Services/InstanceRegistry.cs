using System.Collections.Concurrent;
using Solvix.Control.Models;

namespace Solvix.Control.Services;

// Instances announce themselves by POSTing their registration every few
// seconds, so there is no separate "register" vs "heartbeat": an upsert is
// both, and a restarted panel simply learns everyone again within one beat.
public sealed class InstanceRegistry(TimeProvider time)
{
    public static readonly TimeSpan AliveWindow = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan ForgetAfter = TimeSpan.FromMinutes(2);

    private sealed record Entry(InstanceRegistration Info, DateTimeOffset LastSeen, double Rps);

    private readonly ConcurrentDictionary<string, Entry> _entries = new();

    public event Action? Changed;

    public void Upsert(InstanceRegistration registration)
    {
        var now = time.GetUtcNow();
        _entries.AddOrUpdate(
            registration.Id,
            _ => new Entry(registration, now, 0),
            (_, previous) => new Entry(registration, now, RequestsPerSecond(previous, registration, now)));
        Changed?.Invoke();
    }

    public bool Remove(string id)
    {
        var removed = _entries.TryRemove(id, out _);
        if (removed)
        {
            Changed?.Invoke();
        }
        return removed;
    }

    public IReadOnlyList<InstanceView> Snapshot()
    {
        var now = time.GetUtcNow();
        var views = new List<InstanceView>();
        foreach (var (id, entry) in _entries)
        {
            var age = now - entry.LastSeen;
            if (age > ForgetAfter)
            {
                _entries.TryRemove(id, out _);
                continue;
            }
            var health = age <= AliveWindow ? InstanceHealth.Alive : InstanceHealth.Unresponsive;
            views.Add(new InstanceView(entry.Info, entry.LastSeen, health, entry.Rps));
        }
        return views.OrderBy(v => v.Info.Role).ThenBy(v => v.Info.StartedAt).ToList();
    }

    private static double RequestsPerSecond(Entry previous, InstanceRegistration current, DateTimeOffset now)
    {
        var seconds = (now - previous.LastSeen).TotalSeconds;
        if (previous.Info.Metrics is not { } before || current.Metrics is not { } after || seconds <= 0
            || previous.Info.StartedAt != current.StartedAt)
        {
            return 0;
        }
        return Math.Max(0, (after.RequestsTotal - before.RequestsTotal) / seconds);
    }
}
