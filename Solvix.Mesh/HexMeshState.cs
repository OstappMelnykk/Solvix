namespace Solvix.Mesh;

/// <summary>
/// Plain-data snapshot of a whole mesh: enough to rebuild it exactly (same
/// ids, same links). It is the unit of undo/redo and the shape that will be
/// persisted and sent to clients.
/// </summary>
public sealed record HexMeshState(
    int NextNodeId,
    int NextHexId,
    IReadOnlyList<NodeState> Nodes,
    IReadOnlyList<HexState> Hexes,
    IReadOnlyList<LinkState> Links);

public sealed record NodeState(int Id, Vec3 Position, int IdealX, int IdealY, int IdealZ);

public sealed record HexState(int Id, int I, int J, int K, int? ParentId, IReadOnlyList<int> NodeIds, string? Layer = null, bool Template = false);

/// <summary>One direction of a face link; a link between two hexes appears twice.</summary>
public sealed record LinkState(int Hex, HexFace Face, int Other);
