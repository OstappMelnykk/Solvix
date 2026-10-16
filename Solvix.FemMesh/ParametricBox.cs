namespace Solvix.FemMesh;

/// <summary>
/// Where an element lies inside the cube of the editor it was cut from, in the cube's own coordinates (alpha, beta, gamma), each from -1 to 1:
/// a box. Whatever rule made the elements, they are images of such boxes under the cube's 20-node map, so the box says "where in the cube" independently
/// of the rule and of the cube's real shape. A face of the element is the box with the extent along its normal collapsed to one end.
/// </summary>
public readonly record struct ParametricBox(double X0, double Y0, double Z0, double X1, double Y1, double Z1)
{
    public double Lo(int axis) => axis == 0 ? X0 : axis == 1 ? Y0 : Z0;

    public double Hi(int axis) => axis == 0 ? X1 : axis == 1 ? Y1 : Z1;

    public double Centre(int axis) => 0.5 * (Lo(axis) + Hi(axis));

    /// <summary>The face of this box on the given side of the given axis (sign -1 low, +1 high): the same box with that axis collapsed to the end.</summary>
    public ParametricBox Face(int axis, int sign)
    {
        double end = sign < 0 ? Lo(axis) : Hi(axis);
        return axis == 0 ? this with { X0 = end, X1 = end } : axis == 1 ? this with { Y0 = end, Y1 = end } : this with { Z0 = end, Z1 = end };
    }

    /// <summary>Whether the centre of this box lies inside <paramref name="region"/> along the given axes (low end included, high end not, so neighbouring regions never both own a centre;
    /// the very last cell of the cube owns its end too). <paramref name="tolerance"/> is the width within which two coordinates are the same place.</summary>
    public bool CentreInside(ParametricBox region, IEnumerable<int> axes, double tolerance = 1e-9)
    {
        foreach (int axis in axes)
        {
            double c = Centre(axis);
            bool last = region.Hi(axis) >= 1 - tolerance;
            if (c < region.Lo(axis) - tolerance) return false;
            if (last ? c > region.Hi(axis) + tolerance : c >= region.Hi(axis) - tolerance) return false;
        }
        return true;
    }
}
