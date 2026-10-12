namespace Solvix.Contracts.Facades;

// Wire shapes for the manual hex editor. Faces are named "XMinus", "XPlus",
// "YMinus", "YPlus", "ZMinus", "ZPlus" (the local axis a face is normal to,
// and which side).

/// <param name="IdealX">Ideal-world coordinate in doubled lattice units (divide by 2 for lattice units).</param>
public sealed record MeshNodeDto(int Id, double X, double Y, double Z, int IdealX, int IdealY, int IdealZ);

/// <param name="NodeIds">The 20 node ids: slots 0..7 corners, 8..19 edge midpoints.</param>
/// <param name="Layer">The named group the cube belongs to (enamel, dentin...), or null.</param>
public sealed record MeshHexDto(int Id, int CellI, int CellJ, int CellK, IReadOnlyList<int> NodeIds, string? Layer = null);

public sealed record MeshLinkDto(int HexA, string FaceA, int HexB, string FaceB);

/// <param name="Status">"Free", "Linked" or "Candidate".</param>
public sealed record MeshFaceDto(int Hex, string Face, string Status, int? OtherHex, string? OtherFace, bool? Coincident, double? Gap);

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
public sealed record MeshCommandResultDto(bool Ok, string? Error, MeshStateDto State, string? Info = null);

public sealed record MeshPointDto(double X, double Y, double Z);

/// <summary>A cube designed on its own: the 20 node positions in slot order (0..7 corners, 8..19 edge midpoints).</summary>
public sealed record MeshShapeDto(IReadOnlyList<MeshPointDto> Positions);

/// <summary>A cell of the integer lattice.</summary>
public sealed record MeshCellDto(int I, int J, int K);

public sealed record MeshShapeCheckDto(bool Valid, double MinDeterminant, string? Error);

/// <param name="Taper">Top size / bottom size (1 = straight sides).</param>
/// <param name="ShearX">Sideways travel along X per unit of height.</param>
public sealed record MeshShapeParametersDto(double Length, double Height, double Depth, double Taper, double ShearX, double ShearZ);

public sealed record MeshTemplateParameterDto(string Key, string Label, double Default, double Min, double Max, bool Integer);

/// <summary>A family of bodies (pipe, sphere, torus...) and the parameters that size it; the family keeps its layout whatever the values.</summary>
public sealed record MeshTemplateKindDto(string Name, string Label, string Group, IReadOnlyList<MeshTemplateParameterDto> Parameters);

/// <summary>A named starting point: a kind with its own parameter values (parameters not listed keep their defaults).</summary>
public sealed record MeshTemplatePresetDto(string Name, string Label, string Kind, IReadOnlyDictionary<string, double> Values);

public sealed record MeshTemplateLibraryDto(IReadOnlyList<MeshTemplateKindDto> Kinds, IReadOnlyList<MeshTemplatePresetDto> Presets);

public sealed record MeshTemplateRequestDto(string Kind, IReadOnlyDictionary<string, double>? Values);

/// <param name="State">The body as it would look on its own (null when it could not be built).</param>
/// <param name="FoldedCubes">How many of its cubes have a non-positive Jacobian.</param>
public sealed record MeshTemplatePreviewDto(bool Ok, string? Error, MeshStateDto? State, int FoldedCubes);

public sealed record MeshShapePresetDto(string Name, string Label, MeshShapeParametersDto Parameters);

/// <param name="Found">False when the point lies outside the body.</param>
public sealed record MeshMappingResultDto(bool Found, MeshPointDto? Point);
