using Solvix.FemMesh;

namespace Solvix.Solver.Selections;

/// <summary>
/// A coordinate in a cube's own system (-1 .. 1), counted in billionths so that a place computed two different ways (an even cut, a lattice) is the same
/// number and regions can be compared and hashed exactly.
/// </summary>
internal static class Quantum
{
    public const long One = 1_000_000_000;

    public static long Of(double x) => (long)Math.Round(x * One);
}

/// <summary>
/// A box in a cube's own coordinates, with whole-number (quantized) corners. A face region is a box that is collapsed along the face's normal (low = high):
/// an axis on which a box is collapsed takes no part in comparing, cutting or owning.
/// </summary>
internal readonly record struct Cuboid(long X0, long Y0, long Z0, long X1, long Y1, long Z1)
{
    public long Lo(int axis) => axis == 0 ? X0 : axis == 1 ? Y0 : Z0;

    public long Hi(int axis) => axis == 0 ? X1 : axis == 1 ? Y1 : Z1;

    public bool Collapsed(int axis) => Lo(axis) == Hi(axis);

    public Cuboid With(int axis, long lo, long hi) => axis == 0 ? this with { X0 = lo, X1 = hi } : axis == 1 ? this with { Y0 = lo, Y1 = hi } : this with { Z0 = lo, Z1 = hi };

    public static Cuboid Of(ParametricRegion r) => new(Quantum.Of(r.X0), Quantum.Of(r.Y0), Quantum.Of(r.Z0), Quantum.Of(r.X1), Quantum.Of(r.Y1), Quantum.Of(r.Z1));

    /// <summary>The axes on which the box has a size (a face has two).</summary>
    public IEnumerable<int> Axes()
    {
        for (int axis = 0; axis < 3; axis++)
            if (!Collapsed(axis)) yield return axis;
    }

    /// <summary>Whether the two boxes have a part in common that is not just a border (they must be collapsed on the same axes to meet at all).</summary>
    public bool Overlaps(Cuboid other)
    {
        for (int axis = 0; axis < 3; axis++)
        {
            if (Collapsed(axis) || other.Collapsed(axis))
            {
                if (Collapsed(axis) != other.Collapsed(axis) || Lo(axis) != other.Lo(axis)) return false;
                continue;
            }
            if (Math.Max(Lo(axis), other.Lo(axis)) >= Math.Min(Hi(axis), other.Hi(axis))) return false;
        }
        return true;
    }

    public bool Contains(Cuboid other)
    {
        for (int axis = 0; axis < 3; axis++)
        {
            if (Collapsed(axis) != other.Collapsed(axis)) return false;
            if (Collapsed(axis)) { if (Lo(axis) != other.Lo(axis)) return false; continue; }
            if (other.Lo(axis) < Lo(axis) || other.Hi(axis) > Hi(axis)) return false;
        }
        return true;
    }

    /// <summary>What is left of this box when <paramref name="cut"/> is taken out of it: up to two pieces for each axis the box has a size on.</summary>
    public IEnumerable<Cuboid> Minus(Cuboid cut)
    {
        if (!Overlaps(cut))
        {
            yield return this;
            yield break;
        }
        var rest = this;
        foreach (int axis in Axes())
        {
            if (cut.Lo(axis) > rest.Lo(axis)) yield return rest.With(axis, rest.Lo(axis), cut.Lo(axis));
            if (cut.Hi(axis) < rest.Hi(axis)) yield return rest.With(axis, cut.Hi(axis), rest.Hi(axis));
            rest = rest.With(axis, Math.Max(rest.Lo(axis), cut.Lo(axis)), Math.Min(rest.Hi(axis), cut.Hi(axis)));
        }
    }

    /// <summary>
    /// Whether a place lies in this box along the axes the box has a size on: the low end counts, the high end does not (so two boxes that share a border never both own a place on
    /// it), and the end of the cube itself counts for the last box.
    /// </summary>
    public bool Owns(ParametricPoint point)
    {
        foreach (int axis in Axes())
        {
            long c = Quantum.Of(point[axis]);
            if (c < Lo(axis)) return false;
            if (Hi(axis) >= Quantum.One ? c > Hi(axis) : c >= Hi(axis)) return false;
        }
        return true;
    }
}
