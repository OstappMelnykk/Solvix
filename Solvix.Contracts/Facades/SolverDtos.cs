namespace Solvix.Contracts.Facades;

/// <summary>A solver-ready mesh as flat arrays (what the solver consumes): node coordinates and the 20-node connectivity.</summary>
/// <param name="Positions">x, y, z of each node: length 3 * NodeCount.</param>
/// <param name="Connectivity">The 20 node indices of each element (slots 0..7 corners, 8..19 edge midpoints): length 20 * ElementCount.</param>
/// <param name="NodeIds">Editor node id of each solver node.</param>
/// <param name="ElementIds">Editor hex id of each solver element.</param>
/// <param name="FoldedHexes">Editor hex ids whose map is folded or degenerate.</param>
public sealed record FemMeshDto(
    int NodeCount,
    int ElementCount,
    IReadOnlyList<double> Positions,
    IReadOnlyList<int> Connectivity,
    IReadOnlyList<int> NodeIds,
    IReadOnlyList<int> ElementIds,
    IReadOnlyList<int> FoldedHexes);

/// <summary>Isotropic linear elastic material. E in Pa.</summary>
public sealed record SolverMaterialDto(string Name, string Label, double E, double Nu);

public sealed record SolverFaceDto(int Hex, string Face);

/// <param name="Pressure">Uniform pressure in Pa, positive = pressing into the body.</param>
public sealed record SolverLoadDto(int Hex, string Face, double Pressure);

/// <summary>Everything the user sets for a solve: materials (a library, one per cube), supports and pressures on faces.</summary>
public sealed record SolverSetupDto(
    int Version,
    IReadOnlyList<SolverMaterialDto> Materials,
    string DefaultMaterial,
    IReadOnlyDictionary<int, string> HexMaterials,
    IReadOnlyList<SolverFaceDto> Fixed,
    IReadOnlyList<SolverLoadDto> Loads);

/// <param name="Severity">"error" blocks the solve; "warning" does not.</param>
public sealed record SolverIssueDto(string Severity, string Message);

public sealed record SolverValidationDto(bool CanSolve, IReadOnlyList<SolverIssueDto> Issues);

/// <param name="State">"idle", "running", "done", "failed" or "cancelled".</param>
/// <param name="Progress">0..1.</param>
public sealed record SolverJobDto(string State, double Progress, string Stage, string? Error, int Ticket);

/// <summary>Per solver node (aligned with <see cref="FemMeshDto.NodeIds"/>): displacement and von Mises stress.</summary>
public sealed record SolverResultDto(
    int Ticket,
    IReadOnlyList<int> NodeIds,
    IReadOnlyList<double> Ux,
    IReadOnlyList<double> Uy,
    IReadOnlyList<double> Uz,
    IReadOnlyList<double> VonMises,
    double MaxDisplacement,
    double MaxVonMises,
    double ElapsedSeconds);
