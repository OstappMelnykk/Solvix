namespace Solvix.Mesh;

/// <summary>
/// A cube designed on its own, before it is part of a mesh: the real-space
/// positions of its 20 nodes in slot order (0..7 corners, 8..19 edge midpoints).
/// Its axes are the lattice axes, so it can be attached to any face of the body.
/// </summary>
public sealed class HexShape
{
    public HexShape(IEnumerable<Vec3> positions)
    {
        var list = positions.ToList();
        if (list.Count != Hex20Reference.NodeCount)
            throw new ArgumentException($"A cube shape needs exactly {Hex20Reference.NodeCount} node positions, got {list.Count}.", nameof(positions));
        if (list.Any(p => !double.IsFinite(p.X) || !double.IsFinite(p.Y) || !double.IsFinite(p.Z)))
            throw new ArgumentException("Every position must be a finite number.", nameof(positions));
        Positions = list;
    }

    public IReadOnlyList<Vec3> Positions { get; }

    /// <summary>The regular unit cube with its lower corner at the origin.</summary>
    public static HexShape Unit => Box(1, 1, 1);

    /// <summary>A rectangular block from the origin: length along X, height along Y, depth along Z.</summary>
    public static HexShape Box(double length, double height, double depth) => new(
        Enumerable.Range(0, Hex20Reference.NodeCount).Select(s => new Vec3(
            (Hex20Reference.LocalCoords[s, 0] + 1) / 2.0 * length,
            (Hex20Reference.LocalCoords[s, 1] + 1) / 2.0 * height,
            (Hex20Reference.LocalCoords[s, 2] + 1) / 2.0 * depth)));

    /// <summary>Smallest Jacobian determinant: positive for a valid cube, not positive for a folded or flat one.</summary>
    public double MinDeterminant() => Hex20Geometry.MinDeterminant(Positions);

    public bool IsValid(double minDeterminant = 1e-9) => MinDeterminant() > minDeterminant;
}
