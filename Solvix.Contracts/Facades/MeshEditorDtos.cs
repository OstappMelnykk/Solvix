namespace Solvix.Contracts.Facades;

// Wire shapes for the manual hex editor. Faces are named "XMinus", "XPlus",
// "YMinus", "YPlus", "ZMinus", "ZPlus" (the local axis a face is normal to,
// and which side).

/// <param name="IdealX">Ideal-world coordinate in doubled lattice units (divide by 2 for lattice units).</param>
public sealed record MeshNodeDto(int Id, double X, double Y, double Z, int IdealX, int IdealY, int IdealZ);

/// <param name="NodeIds">The 20 node ids: slots 0..7 corners, 8..19 edge midpoints.</param>
public sealed record MeshHexDto(int Id, int CellI, int CellJ, int CellK, IReadOnlyList<int> NodeIds);

/// <param name="Seam">The two faces are not opposite faces of lattice-adjacent cubes: they meet only because nodes were moved (e.g. three cubes around an edge). In the ideal world the cubes stay in their own cells and the link is a seam.</param>
public sealed record MeshLinkDto(int HexA, string FaceA, int HexB, string FaceB, bool Seam);

/// <param name="Status">"Free", "Linked" or "Candidate".</param>
public sealed record MeshFaceDto(int Hex, string Face, string Status, int? OtherHex, string? OtherFace, bool? Coincident, double? Gap, bool Seam);

public sealed record MeshStateDto(
    int Version,
    bool CanUndo,
    bool CanRedo,
    IReadOnlyList<MeshNodeDto> Nodes,
    IReadOnlyList<MeshHexDto> Hexes,
    IReadOnlyList<MeshLinkDto> Links,
    IReadOnlyList<MeshFaceDto> Faces,
    IReadOnlyList<int> InvalidHexes);

/// <summary>Result of an editing command; the state is always the current one, also on failure.</summary>
public sealed record MeshCommandResultDto(bool Ok, string? Error, MeshStateDto State);

public sealed record MeshPointDto(double X, double Y, double Z);

/// <param name="Found">False when the point lies outside the body.</param>
public sealed record MeshMappingResultDto(bool Found, MeshPointDto? Point);
