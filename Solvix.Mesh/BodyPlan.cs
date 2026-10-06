namespace Solvix.Mesh;

/// <summary>One cube of a ready-made body: its lattice cell and the 20 node positions in slot order.</summary>
public sealed record BodyCell(int I, int J, int K, IReadOnlyList<Vec3> Positions);

/// <summary>
/// A whole body prepared outside any mesh - the cells it occupies on the ideal lattice
/// and where each cube's 20 nodes lie in the real world. Every pair of cells that
/// are lattice-adjacent is a neighbour (linked), so the body arrives already stitched.
/// </summary>
public sealed class BodyPlan
{
    public BodyPlan(IEnumerable<BodyCell> cells, bool wrapI = false, bool wrapJ = false, bool wrapK = false)
    {
        WrapAxes = new[] { wrapI, wrapJ, wrapK };
        Cells = cells.ToList();
        if (Cells.Count == 0) throw new ArgumentException("A body needs at least one cube.");
        var seen = new HashSet<(int, int, int)>();
        foreach (var c in Cells)
        {
            if (c.Positions.Count != Hex20Reference.NodeCount)
                throw new ArgumentException($"A cube needs {Hex20Reference.NodeCount} node positions, got {c.Positions.Count}.");
            if (c.Positions.Any(p => !double.IsFinite(p.X) || !double.IsFinite(p.Y) || !double.IsFinite(p.Z)))
                throw new ArgumentException("Node positions must be finite numbers.");
            if (!seen.Add((c.I, c.J, c.K))) throw new ArgumentException($"Cell ({c.I}, {c.J}, {c.K}) appears twice.");
        }
        for (int axis = 0; axis < 3; axis++)
        {
            if (!WrapAxes[axis]) continue;
            int extent = Max.ToArray()[axis] - Min.ToArray()[axis] + 1;
            if (extent < 3) throw new ArgumentException($"A ring needs at least 3 cubes along the closed axis, got {extent}.");
        }
    }

    /// <summary>Which lattice axes (I, J, K) close into a loop: the last layer links to the first.</summary>
    public IReadOnlyList<bool> WrapAxes { get; }

    public IReadOnlyList<BodyCell> Cells { get; }

    public (int I, int J, int K) Min => (Cells.Min(c => c.I), Cells.Min(c => c.J), Cells.Min(c => c.K));
    public (int I, int J, int K) Max => (Cells.Max(c => c.I), Cells.Max(c => c.J), Cells.Max(c => c.K));
}

internal static class CellTupleExtensions
{
    public static int[] ToArray(this (int I, int J, int K) cell) => new[] { cell.I, cell.J, cell.K };
}
