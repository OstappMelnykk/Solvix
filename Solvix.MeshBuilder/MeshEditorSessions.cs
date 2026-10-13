using System.Collections.Concurrent;
using Solvix.Mesh;

namespace Solvix.MeshBuilder;

/// <summary>
/// In-memory editors, one per client session. Singleton: the facade itself is
/// scoped per request, but a session's mesh has to outlive requests. Access to
/// one editor is serialised; different sessions never block each other.
/// </summary>
internal sealed class MeshEditorSessions
{
    private readonly ConcurrentDictionary<int, Session> _sessions = new();

    public T With<T>(int sessionId, Func<HexMeshEditor, T> work)
    {
        var session = _sessions.GetOrAdd(sessionId, _ => new Session());
        lock (session) return work(session.Editor);
    }

    /// <summary>Forgets a session entirely - its mesh and its undo history. Unknown ids are ignored.</summary>
    public void Remove(int sessionId) => _sessions.TryRemove(sessionId, out _);

    private sealed class Session
    {
        public HexMeshEditor Editor { get; } = new();
    }
}
