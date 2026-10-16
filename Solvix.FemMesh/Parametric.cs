namespace Solvix.FemMesh;

/// <summary>
/// A place inside a cube of the editor, in the cube's own coordinates (alpha, beta, gamma), each from -1 to 1. Whatever rule made the elements, they are
/// images of regions of the cube under the cube's 20-node map, so "where in the cube" says where an element or a face is independently of the rule and of
/// the cube's real shape. An element is placed by its centre (the middle of its corners), a face of it by the middle of the face's corners.
/// </summary>
public readonly record struct ParametricPoint(double X, double Y, double Z)
{
    public double this[int axis] => axis == 0 ? X : axis == 1 ? Y : Z;
}

/// <summary>
/// A region of a cube (a box in its own coordinates): the cell of a grid the user set something on. A region OWNS a point when the point lies in it
/// along the given axes - the low end included, the high end not, so that two neighbouring regions never both own a point on their border; the last
/// region of the cube owns the end of the cube too. <paramref name="tolerance"/> is the width within which two coordinates are the same place.
/// </summary>
public readonly record struct ParametricRegion(double X0, double Y0, double Z0, double X1, double Y1, double Z1)
{
    public double Lo(int axis) => axis == 0 ? X0 : axis == 1 ? Y0 : Z0;

    public double Hi(int axis) => axis == 0 ? X1 : axis == 1 ? Y1 : Z1;

    public bool Owns(ParametricPoint point, IEnumerable<int> axes, double tolerance = 1e-9)
    {
        foreach (int axis in axes)
        {
            double c = point[axis];
            bool last = Hi(axis) >= 1 - tolerance;
            if (c < Lo(axis) - tolerance) return false;
            if (last ? c > Hi(axis) + tolerance : c >= Hi(axis) - tolerance) return false;
        }
        return true;
    }
}
