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

/// <summary>Ready-made shapes: the parametric block and the library of presets built from it.</summary>
public static class HexShapes
{
    /// <summary>
    /// A block from the origin with length along X, height along Y and depth along Z,
    /// whose top can be scaled (<paramref name="taper"/> = top size / bottom size, 1 = straight
    /// sides) and slid sideways (<paramref name="shearX"/>, <paramref name="shearZ"/> = sideways
    /// travel per unit of height). Every one of the 20 nodes, midpoints included, is placed by the
    /// same formula, so sides stay straight.
    /// </summary>
    public static HexShape Parametric(double length, double height, double depth, double taper = 1, double shearX = 0, double shearZ = 0) => new(
        Enumerable.Range(0, Hex20Reference.NodeCount).Select(s =>
        {
            double x = (Hex20Reference.LocalCoords[s, 0] + 1) / 2.0 * length;
            double y = (Hex20Reference.LocalCoords[s, 1] + 1) / 2.0 * height;
            double z = (Hex20Reference.LocalCoords[s, 2] + 1) / 2.0 * depth;
            double scale = 1 + (taper - 1) * (height == 0 ? 0 : y / height);
            return new Vec3(length / 2 + (x - length / 2) * scale + shearX * y, y, depth / 2 + (z - depth / 2) * scale + shearZ * y);
        }));

    public sealed record Preset(string Name, string Label, double Length, double Height, double Depth, double Taper, double ShearX, double ShearZ)
    {
        public HexShape Build() => Parametric(Length, Height, Depth, Taper, ShearX, ShearZ);
    }

    /// <summary>The library offered by the constructor window.</summary>
    public static IReadOnlyList<Preset> Presets { get; } = new[]
    {
        new Preset("unit", "Одиничний куб", 1, 1, 1, 1, 0, 0),
        new Preset("beam", "Брус 3×1×1", 3, 1, 1, 1, 0, 0),
        new Preset("plate", "Пластина 3×0.3×3", 3, 0.3, 3, 1, 0, 0),
        new Preset("tower", "Стовп 1×3×1", 1, 3, 1, 1, 0, 0),
        new Preset("tapered", "Зрізана піраміда (верх ×0.5)", 1, 1, 1, 0.5, 0, 0),
        new Preset("skewed", "Похилий паралелепіпед", 1, 1, 1, 1, 0.5, 0),
    };
}
