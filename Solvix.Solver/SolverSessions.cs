using System.Collections.Concurrent;
using Solvix.Contracts.Facades;

namespace Solvix.Solver;

/// <summary>
/// In-memory set-up and solve state, one entry per client session. Singleton (the facade is scoped per request,
/// but a background solve and its result outlive requests); access to one session is serialised.
/// </summary>
internal sealed class SolverSessions
{
    private readonly ConcurrentDictionary<int, Session> _sessions = new();

    public T With<T>(int sessionId, Func<Session, T> work)
    {
        var session = _sessions.GetOrAdd(sessionId, _ => new Session());
        lock (session) return work(session);
    }

    public void Remove(int sessionId)
    {
        if (_sessions.TryRemove(sessionId, out var session))
            lock (session) session.Cancel?.Cancel();
    }

    internal sealed class Session
    {
        public SolverSetup Setup { get; } = new();
        public SolverJobDto Job { get; set; } = new("idle", 0, "", null, 0);
        public SolverResultDto? Result { get; set; }
        public CancellationTokenSource? Cancel { get; set; }
        public int Ticket { get; set; }
    }
}
