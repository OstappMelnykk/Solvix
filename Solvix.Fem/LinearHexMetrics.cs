namespace Solvix.Fem;

/// <summary>
/// The measures of a hexahedron that other mesh tools report, computed from its eight corner nodes only (the way they
/// treat even a quadratic element): edge lengths and angles of the straight edges, the principal axes at the centre
/// (Cubit/Verdict aspect, skew and taper), the diagonals, and the Jacobian matrix at each corner (scaled Jacobian,
/// condition number, shear, shape). Used to compare how differently the same mesh is judged by different standards.
/// </summary>
/// <param name="EdgeRatio">Longest / shortest of the 12 straight edges (Abaqus, HyperMesh aspect ratio).</param>
/// <param name="FaceMinAngle">Smallest face corner angle, degrees (Abaqus "smaller face corner angle").</param>
/// <param name="FaceMaxAngle">Largest face corner angle, degrees (Abaqus "larger face corner angle").</param>
/// <param name="EquiangleSkew">max((largest face angle - 90) / 90, (90 - smallest face angle) / 90): 0 equiangular, 1 degenerate.</param>
/// <param name="AxesAspect">Longest / shortest principal axis at the centre (Cubit "aspect ratio").</param>
/// <param name="Skew">Largest |cos| of the angle between two principal axes (Cubit "skew").</param>
/// <param name="Taper">Largest ratio of a cross-difference of opposite edges to the shorter of its two axes (Cubit "taper").</param>
/// <param name="Stretch">sqrt(3) * shortest edge / longest diagonal (Cubit "stretch").</param>
/// <param name="DiagonalRatio">Shortest / longest of the four body diagonals (Cubit "diagonal ratio").</param>
/// <param name="ConditionNumber">Largest condition number of the corner Jacobian matrices, 1 for a cube (Cubit "condition no.").</param>
/// <param name="ScaledJacobian">Smallest det / (product of the three edge lengths) over the corners.</param>
/// <param name="Shear">Smallest over the corners of 3 det^(2/3) / |A|^2 with the columns of A made unit length.</param>
/// <param name="Shape">Smallest over the corners of 3 det^(2/3) / |A|^2.</param>
public readonly record struct LinearHexMetrics(
    double EdgeRatio, double FaceMinAngle, double FaceMaxAngle, double EquiangleSkew,
    double AxesAspect, double Skew, double Taper, double Stretch, double DiagonalRatio,
    double ConditionNumber, double ScaledJacobian, double Shear, double Shape)
{
    private static readonly int[][] Faces =
    {
        new[] { 0, 1, 2, 3 }, new[] { 4, 5, 6, 7 }, new[] { 0, 1, 5, 4 }, new[] { 1, 2, 6, 5 }, new[] { 2, 3, 7, 6 }, new[] { 3, 0, 4, 7 },
    };

    private static readonly (int, int)[] Edges =
    {
        (0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7),
    };

    // For each corner, its neighbour along the local axis xi, eta and zeta, and whether the edge vectors in that order
    // are left-handed (an odd number of the corner's coordinates is +1), in which case one is flipped.
    private static readonly (int[] Neighbours, bool Flip)[] Around = Enumerable.Range(0, 8).Select(c =>
    {
        var neighbours = new int[3];
        for (int axis = 0; axis < 3; axis++)
            for (int n = 0; n < 8; n++)
            {
                bool same = true;
                for (int k = 0; k < 3; k++)
                    if ((Hex20.Local[n, k] == Hex20.Local[c, k]) == (k == axis)) same = false;
                if (same) neighbours[axis] = n;
            }
        int plus = Enumerable.Range(0, 3).Count(k => Hex20.Local[c, k] > 0);
        return (neighbours, plus % 2 == 1);
    }).ToArray();

    public static LinearHexMetrics Of(double[,] xyz)
    {
        double[] P(int i) => new[] { xyz[i, 0], xyz[i, 1], xyz[i, 2] };
        var p = Enumerable.Range(0, 8).Select(P).ToArray();

        // edges
        double shortest = double.MaxValue, longest = 0;
        foreach (var (a, b) in Edges)
        {
            double length = Norm(Sub(p[b], p[a]));
            shortest = Math.Min(shortest, length); longest = Math.Max(longest, length);
        }

        // face corner angles
        double minAngle = 180, maxAngle = 0;
        foreach (var face in Faces)
            for (int k = 0; k < 4; k++)
            {
                double angle = Angle(Sub(p[face[(k + 1) % 4]], p[face[k]]), Sub(p[face[(k + 3) % 4]], p[face[k]]));
                if (double.IsNaN(angle)) continue;
                minAngle = Math.Min(minAngle, angle); maxAngle = Math.Max(maxAngle, angle);
            }
        if (maxAngle < minAngle) { minAngle = 90; maxAngle = 90; }

        // principal axes at the centre and their cross differences
        double[] x1 = Add(Add(Sub(p[1], p[0]), Sub(p[2], p[3])), Add(Sub(p[5], p[4]), Sub(p[6], p[7])));
        double[] x2 = Add(Add(Sub(p[3], p[0]), Sub(p[2], p[1])), Add(Sub(p[7], p[4]), Sub(p[6], p[5])));
        double[] x3 = Add(Add(Sub(p[4], p[0]), Sub(p[5], p[1])), Add(Sub(p[6], p[2]), Sub(p[7], p[3])));
        double[] x12 = Add(Sub(Sub(p[2], p[3]), Sub(p[1], p[0])), Sub(Sub(p[6], p[7]), Sub(p[5], p[4])));
        double[] x13 = Add(Sub(Sub(p[5], p[1]), Sub(p[4], p[0])), Sub(Sub(p[6], p[2]), Sub(p[7], p[3])));
        double[] x23 = Add(Sub(Sub(p[7], p[4]), Sub(p[3], p[0])), Sub(Sub(p[6], p[5]), Sub(p[2], p[1])));
        double l1 = Norm(x1), l2 = Norm(x2), l3 = Norm(x3);
        double axesAspect = Math.Min(l1, Math.Min(l2, l3)) > 0 ? Math.Max(l1, Math.Max(l2, l3)) / Math.Min(l1, Math.Min(l2, l3)) : double.PositiveInfinity;
        double skew = Math.Max(Cos(x1, x2), Math.Max(Cos(x1, x3), Cos(x2, x3)));
        double Ratio(double[] cross, double a, double b) => Math.Min(a, b) > 0 ? Norm(cross) / Math.Min(a, b) : double.PositiveInfinity;
        double taper = Math.Max(Ratio(x12, l1, l2), Math.Max(Ratio(x13, l1, l3), Ratio(x23, l2, l3)));

        // diagonals
        double[] diagonals = { Norm(Sub(p[6], p[0])), Norm(Sub(p[7], p[1])), Norm(Sub(p[4], p[2])), Norm(Sub(p[5], p[3])) };
        double maxDiagonal = diagonals.Max(), minDiagonal = diagonals.Min();

        // the Jacobian matrix at each corner
        double scaled = double.MaxValue, shear = double.MaxValue, shape = double.MaxValue, condition = 0;
        for (int c = 0; c < 8; c++)
        {
            var e = Around[c].Neighbours.Select(n => Sub(p[n], p[c])).ToArray();   // the three edge vectors as columns
            if (Around[c].Flip) e[0] = new[] { -e[0][0], -e[0][1], -e[0][2] };
            double det = Dot(e[0], Cross(e[1], e[2]));
            double lengths = Norm(e[0]) * Norm(e[1]) * Norm(e[2]);
            scaled = Math.Min(scaled, lengths > 0 ? det / lengths : 0);
            if (!(det > 0) || lengths == 0)
            {
                shear = 0; shape = 0; condition = double.PositiveInfinity;
                continue;
            }
            double frob = e.Sum(v => Dot(v, v));
            shape = Math.Min(shape, 3 * Math.Pow(det, 2.0 / 3) / frob);
            // unit-length columns: the shape of the angles alone
            double unitDet = det / lengths;
            shear = Math.Min(shear, Math.Pow(unitDet, 2.0 / 3));
            // |A| |A^-1| / 3 with the Frobenius norm; A^-1 is the adjugate / det
            double inverse = (Dot(Cross(e[1], e[2]), Cross(e[1], e[2])) + Dot(Cross(e[2], e[0]), Cross(e[2], e[0])) + Dot(Cross(e[0], e[1]), Cross(e[0], e[1]))) / (det * det);
            condition = Math.Max(condition, Math.Sqrt(frob * inverse) / 3);
        }

        return new LinearHexMetrics(
            shortest > 0 ? longest / shortest : double.PositiveInfinity, minAngle, maxAngle, Math.Max((maxAngle - 90) / 90, (90 - minAngle) / 90),
            axesAspect, skew, taper, maxDiagonal > 0 ? Math.Sqrt(3) * shortest / maxDiagonal : 0, maxDiagonal > 0 ? minDiagonal / maxDiagonal : 0,
            condition, Math.Max(-1, scaled), Math.Max(0, shear), Math.Max(0, shape));
    }

    private static double[] Sub(double[] a, double[] b) => new[] { a[0] - b[0], a[1] - b[1], a[2] - b[2] };
    private static double[] Add(double[] a, double[] b) => new[] { a[0] + b[0], a[1] + b[1], a[2] + b[2] };
    private static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    private static double Norm(double[] a) => Math.Sqrt(Dot(a, a));
    private static double[] Cross(double[] a, double[] b) => new[] { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
    private static double Cos(double[] a, double[] b) => Norm(a) > 0 && Norm(b) > 0 ? Math.Abs(Dot(a, b)) / (Norm(a) * Norm(b)) : 1;
    private static double Angle(double[] a, double[] b) => Norm(a) > 0 && Norm(b) > 0 ? Math.Acos(Math.Clamp(Dot(a, b) / (Norm(a) * Norm(b)), -1, 1)) * 180 / Math.PI : double.NaN;
}
