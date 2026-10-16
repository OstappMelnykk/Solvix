using Solvix.FemMesh;

namespace Solvix.Solver.Selections;

/// <summary>
/// A place in a cube that something was set on: where the user pointed, in the cube's own coordinates, independent of how the body is cut into elements.
/// A box (a cell of a grid, a face that is a rectangle) owns a place with the low end in and the high end out, so two boxes that share a border never both own
/// a place on it. A face that is not a rectangle (a trapezoid beside a transition cell) is a convex polygon, and an element that is not a box (a wedge) is a convex
/// solid; those own their border too (and the newer thing set wins where two meet). All corners are quantized (billionths), so shapes compare exactly.
/// </summary>
internal abstract class Shape : IEquatable<Shape>
{
    /// <summary>The smallest box that holds the shape (collapsed along the normal for a flat one); used to skip shapes far from a place.</summary>
    public abstract Cuboid Bounds { get; }

    public abstract bool Contains(ParametricPoint at);

    /// <summary>Places inside the shape, spread over it: if a value is already everywhere on all of them, setting it again is taken to change nothing.</summary>
    public abstract IEnumerable<ParametricPoint> Samples();

    public abstract bool Equals(Shape? other);

    public override bool Equals(object? obj) => obj is Shape s && Equals(s);

    public abstract override int GetHashCode();

    // ---- from the mesh ----

    /// <summary>The shape of a face of an element that lies on a side of its cube: the quadrilateral between its corners.</summary>
    public static Shape OfFace(IFemMesh mesh, ElementFace face)
    {
        var (axis, _) = ElementLocal.FaceAxis(face.Face);
        var corners = mesh.CornersOf(face.Element);
        var points = ElementLocal.FaceNodes[face.Face].Where(n => n < 8).Select(n => corners[n]).ToArray();
        long plane = Quantum.Of(points.Average(p => p[axis]));
        var tangents = Enumerable.Range(0, 3).Where(d => d != axis).ToArray();
        var quad = points.Select(p => (U: Quantum.Of(p[tangents[0]]), V: Quantum.Of(p[tangents[1]]))).ToArray();
        long u0 = quad.Min(q => q.U), u1 = quad.Max(q => q.U), v0 = quad.Min(q => q.V), v1 = quad.Max(q => q.V);
        bool rectangle = quad.All(q => (q.U == u0 || q.U == u1) && (q.V == v0 || q.V == v1)) && quad.Select(q => q).Distinct().Count() == 4;
        if (rectangle)
        {
            var box = new Cuboid(0, 0, 0, 0, 0, 0).With(axis, plane, plane).With(tangents[0], u0, u1).With(tangents[1], v0, v1);
            return new BoxShape(box);
        }
        return new PolygonShape(axis, plane, tangents[0], tangents[1], quad);
    }

    /// <summary>The shape of an element: the hexahedron between its corners.</summary>
    public static Shape OfElement(IFemMesh mesh, int element)
    {
        var corners = mesh.CornersOf(element).Take(8).Select(p => (X: Quantum.Of(p.X), Y: Quantum.Of(p.Y), Z: Quantum.Of(p.Z))).ToArray();
        long x0 = corners.Min(c => c.X), x1 = corners.Max(c => c.X), y0 = corners.Min(c => c.Y), y1 = corners.Max(c => c.Y), z0 = corners.Min(c => c.Z), z1 = corners.Max(c => c.Z);
        bool box = corners.All(c => (c.X == x0 || c.X == x1) && (c.Y == y0 || c.Y == y1) && (c.Z == z0 || c.Z == z1)) && corners.Distinct().Count() == 8;
        return box ? new BoxShape(new Cuboid(x0, y0, z0, x1, y1, z1)) : new HullShape(corners);
    }

    protected static IEnumerable<ParametricPoint> Inset(IReadOnlyList<ParametricPoint> corners)
    {
        var middle = new ParametricPoint(corners.Average(p => p.X), corners.Average(p => p.Y), corners.Average(p => p.Z));
        yield return middle;
        foreach (var p in corners)
            yield return new ParametricPoint(middle.X + 0.7 * (p.X - middle.X), middle.Y + 0.7 * (p.Y - middle.Y), middle.Z + 0.7 * (p.Z - middle.Z));
    }
}

internal sealed class BoxShape(Cuboid box) : Shape
{
    public Cuboid Box { get; } = box;

    public override Cuboid Bounds => Box;

    public override bool Contains(ParametricPoint at) => Box.Owns(at);

    public override IEnumerable<ParametricPoint> Samples()
    {
        // a 3 x 3 (x 3) grid of places inside the box, on the axes the box has a size on
        var axes = Box.Axes().ToArray();
        var places = new List<double[]> { new double[3] };
        for (int axis = 0; axis < 3; axis++)
        {
            double[] at = Box.Collapsed(axis) ? new[] { (double)Box.Lo(axis) / Quantum.One } : new[] { 1.0 / 6, 0.5, 5.0 / 6 }.Select(t => (Box.Lo(axis) + t * (Box.Hi(axis) - Box.Lo(axis))) / Quantum.One).ToArray();
            places = places.SelectMany(p => at.Select(v => { var q = (double[])p.Clone(); q[axis] = v; return q; })).ToList();
        }
        return places.Select(p => new ParametricPoint(p[0], p[1], p[2]));
    }

    public override bool Equals(Shape? other) => other is BoxShape b && b.Box == Box;

    public override int GetHashCode() => Box.GetHashCode();
}

internal sealed class PolygonShape : Shape
{
    private readonly int _normal, _u, _v;
    private readonly long _plane;
    private readonly (long U, long V)[] _corners;                        // in order round the polygon, counter-clockwise

    public PolygonShape(int normalAxis, long plane, int uAxis, int vAxis, (long U, long V)[] corners)
    {
        (_normal, _plane, _u, _v) = (normalAxis, plane, uAxis, vAxis);
        double cu = corners.Average(c => (double)c.U), cv = corners.Average(c => (double)c.V);
        _corners = corners.OrderBy(c => Math.Atan2(c.V - cv, c.U - cu)).ToArray();
    }

    public override Cuboid Bounds =>
        new Cuboid(0, 0, 0, 0, 0, 0).With(_normal, _plane, _plane).With(_u, _corners.Min(c => c.U), _corners.Max(c => c.U)).With(_v, _corners.Min(c => c.V), _corners.Max(c => c.V));

    public override bool Contains(ParametricPoint at)
    {
        long pu = Quantum.Of(at[_u]), pv = Quantum.Of(at[_v]);
        for (int i = 0; i < _corners.Length; i++)
        {
            var (a, b) = (_corners[i], _corners[(i + 1) % _corners.Length]);
            Int128 cross = (Int128)(b.U - a.U) * (pv - a.V) - (Int128)(b.V - a.V) * (pu - a.U);
            if (cross < 0) return false;
        }
        return true;
    }

    public override IEnumerable<ParametricPoint> Samples()
    {
        var corners = _corners.Select(c =>
        {
            var p = new double[3];
            p[_normal] = (double)_plane / Quantum.One;
            p[_u] = (double)c.U / Quantum.One;
            p[_v] = (double)c.V / Quantum.One;
            return new ParametricPoint(p[0], p[1], p[2]);
        }).ToList();
        return Inset(corners);
    }

    public override bool Equals(Shape? other) =>
        other is PolygonShape p && p._normal == _normal && p._plane == _plane && p._u == _u && p._v == _v && p._corners.SequenceEqual(_corners);

    public override int GetHashCode() => HashCode.Combine(_normal, _plane, _corners.Length, _corners.Length > 0 ? _corners[0] : default);
}

internal sealed class HullShape : Shape
{
    private readonly (long X, long Y, long Z)[] _corners;
    private readonly List<((long, long, long) At, (Int128, Int128, Int128) Normal)> _planes = new();

    public HullShape((long X, long Y, long Z)[] corners)
    {
        _corners = corners;
        // the faces of the convex hull: every plane through three corners that has all the others on one side
        for (int i = 0; i < corners.Length; i++)
            for (int j = i + 1; j < corners.Length; j++)
                for (int k = j + 1; k < corners.Length; k++)
                {
                    var n = Cross(Sub(corners[j], corners[i]), Sub(corners[k], corners[i]));
                    if (n.Item1 == 0 && n.Item2 == 0 && n.Item3 == 0) continue;
                    int below = 0, above = 0;
                    foreach (var c in corners)
                    {
                        var d = Dot(n, Sub(c, corners[i]));
                        if (d < 0) below++;
                        else if (d > 0) above++;
                    }
                    if (below > 0 && above > 0) continue;                       // the plane cuts the solid: not a face of the hull
                    if (above > 0) n = (-n.Item1, -n.Item2, -n.Item3);           // make the normal point out
                    _planes.Add((corners[i], n));
                }
    }

    private static (Int128, Int128, Int128) Sub((long X, long Y, long Z) a, (long X, long Y, long Z) b) => (a.X - b.X, a.Y - b.Y, a.Z - b.Z);

    private static (Int128, Int128, Int128) Cross((Int128 X, Int128 Y, Int128 Z) a, (Int128 X, Int128 Y, Int128 Z) b) =>
        (a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X);

    private static Int128 Dot((Int128 X, Int128 Y, Int128 Z) a, (Int128 X, Int128 Y, Int128 Z) b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

    public override Cuboid Bounds => new(_corners.Min(c => c.X), _corners.Min(c => c.Y), _corners.Min(c => c.Z), _corners.Max(c => c.X), _corners.Max(c => c.Y), _corners.Max(c => c.Z));

    public override bool Contains(ParametricPoint at)
    {
        var p = (X: Quantum.Of(at.X), Y: Quantum.Of(at.Y), Z: Quantum.Of(at.Z));
        foreach (var (origin, normal) in _planes)
            if (Dot(normal, Sub(p, origin)) > 0) return false;
        return true;
    }

    public override IEnumerable<ParametricPoint> Samples() =>
        Inset(_corners.Select(c => new ParametricPoint((double)c.X / Quantum.One, (double)c.Y / Quantum.One, (double)c.Z / Quantum.One)).ToList());

    public override bool Equals(Shape? other) => other is HullShape h && h._corners.OrderBy(c => c).SequenceEqual(_corners.OrderBy(c => c));

    public override int GetHashCode() => HashCode.Combine(_corners.Length, _corners.Min(), _corners.Max());
}
