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

/// <summary>A face of a cube, or one small face of it: <c>P</c>, <c>Q</c> are the cell in the side's grid (p along the lower of the face's two tangent axes, q along the higher); null means the whole side.</summary>
public sealed record SolverFaceDto(int Hex, string Face, int? P = null, int? Q = null);

/// <summary>One small element of a divided cube, by its index along each of the cube's axes.</summary>
public sealed record SolverElementDto(int Hex, int Ex, int Ey, int Ez);

public sealed record SolverElementMaterialDto(int Hex, int Ex, int Ey, int Ez, string Material);

/// <param name="Pressure">Uniform normal pressure Pn in Pa along the outward normal, as in the solver: negative = pressing into the body (compression), positive = pulling out.</param>
public sealed record SolverLoadDto(int Hex, string Face, double Pressure, int? P = null, int? Q = null);

/// <summary>Everything the user sets for a solve: materials (a library, one per cube), supports and pressures on faces.</summary>
/// <param name="Divisions">How many small elements each cube is cut into along its three axes (the solver's Nx, Ny, Nz).</param>
public sealed record SolverSetupDto(
    int Version,
    IReadOnlyList<int> Divisions,
    IReadOnlyList<SolverMaterialDto> Materials,
    string DefaultMaterial,
    IReadOnlyDictionary<int, string> HexMaterials,
    IReadOnlyList<SolverElementMaterialDto> ElementMaterials,
    IReadOnlyList<SolverFaceDto> Fixed,
    IReadOnlyList<SolverLoadDto> Loads);

/// <param name="Severity">"error" blocks the solve; "warning" does not.</param>
public sealed record SolverIssueDto(string Severity, string Message);

public sealed record SolverValidationDto(bool CanSolve, IReadOnlyList<SolverIssueDto> Issues);

/// <param name="State">"idle", "running", "done", "failed" or "cancelled".</param>
/// <param name="Progress">0..1.</param>
public sealed record SolverJobDto(string State, double Progress, string Stage, string? Error, int Ticket);

/// <summary>
/// The solution on the mesh the solver worked on (every cube cut into Divisions small elements). Values are per
/// node of that mesh; <see cref="GridNodes"/> says which node sits at each grid point of each cube.
/// </summary>
/// <param name="Positions">x, y, z of each node (undeformed): length 3 * node count.</param>
/// <param name="HexIds">The editor cube behind each block of <see cref="GridNodes"/>.</param>
/// <param name="GridNodes">For each cube of <see cref="HexIds"/>, the node at each existing grid point (ix, iy, iz in 0..2n, at most one odd; iz slowest, ix fastest).</param>
public sealed record SolverResultDto(
    int Ticket,
    IReadOnlyList<int> Divisions,
    IReadOnlyList<double> Positions,
    IReadOnlyList<int> HexIds,
    IReadOnlyList<int> GridNodes,
    IReadOnlyList<double> Ux,
    IReadOnlyList<double> Uy,
    IReadOnlyList<double> Uz,
    IReadOnlyList<double> VonMises,
    double MaxDisplacement,
    double MaxVonMises,
    double ElapsedSeconds);

/// <summary>
/// The quality of the mesh the solver would work on (every cube cut into the current division), judged by several
/// standards (profiles) so they can be compared: each profile has its own measures and limits.
/// </summary>
public sealed record SolverQualityReportDto(IReadOnlyList<SolverQualityDto> Profiles);

/// <summary>
/// How one profile judges the mesh: counts per grade over all small elements, the worst value of each of its
/// measures, and the small elements that are not excellent.
/// </summary>
/// <param name="Id">"solvix", "abaqus", "cubit", "altair" or "ansys".</param>
/// <param name="Source">Where the measures and limits come from.</param>
/// <param name="Note">What is different from the original or not evaluated.</param>
/// <param name="Grades">Small elements per grade: "excellent", "good", "acceptable", "poor", "invalid". A profile with
/// only a pass limit per measure uses "excellent" for passing and "poor" for failing.</param>
/// <param name="Worst">The worst value of each measure (by its key) over all elements; for the angle measures also
/// "minAngle" and "maxAngle".</param>
public sealed record SolverQualityDto(
    string Id,
    string Name,
    string Source,
    string Note,
    int Elements,
    IReadOnlyDictionary<string, int> Grades,
    IReadOnlyDictionary<string, double> Worst,
    IReadOnlyList<SolverQualityLimitDto> Limits,
    IReadOnlyList<SolverElementQualityDto> Flagged);

/// <summary>
/// One small element that is not excellent by a profile: the cube it lies in, its place (Ex, Ey, Ez) in that cube,
/// its grade and its value of every measure of the profile (by key).
/// </summary>
public sealed record SolverElementQualityDto(int Hex, int Ex, int Ey, int Ez, string Grade, IReadOnlyDictionary<string, double> Values);

/// <summary>One measure of element quality and where its grades change.</summary>
/// <param name="Key">Identifies the measure within the profile.</param>
/// <param name="Label">Plain name; <paramref name="Short"/> for a narrow button; <paramref name="Tech"/> the technical name.</param>
/// <param name="HigherIsBetter">True when a larger value is better.</param>
/// <param name="Levels">4: the bounds split excellent | good | acceptable | poor. 2: one bound, pass or fail.</param>
/// <param name="Bounds">With 4 levels the three limits in the order of the measure's goodness; with 2 the one limit
/// (a value equal to it passes).</param>
/// <param name="Kind">"plain", or "angleDeviation": the value is the distance of the worst angle from 90 degrees.</param>
public sealed record SolverQualityLimitDto(
    string Key, string Label, string Short, string Tech, string Hint,
    bool HigherIsBetter, int Levels, IReadOnlyList<double> Bounds, string Unit, int Decimals, string Kind);
