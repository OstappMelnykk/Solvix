namespace Solvix.Mesh;

/// <summary>
/// Solver-ready snapshot of the mesh: the same shape the FEM solver consumes
/// (<c>Positions[n,3]</c>, <c>Connectivity[e,20]</c>, slots 0..7 corners and
/// 8..19 edge midpoints). Shared nodes appear once.
/// </summary>
public sealed class FemMeshData
{
    public required int NodeCount { get; init; }
    public required int ElementCount { get; init; }
    public required double[,] Positions { get; init; }
    public required int[,] Connectivity { get; init; }
    /// <summary>Mesh node id for each solver node index.</summary>
    public required int[] NodeIds { get; init; }
    /// <summary>Hex id for each solver element index.</summary>
    public required int[] ElementIds { get; init; }
    /// <summary>The cell (I, J, K) of the editor's lattice each element sits in: three numbers per element, in the order of <see cref="ElementIds"/>.</summary>
    public int[] Cells { get; init; } = Array.Empty<int>();
}
