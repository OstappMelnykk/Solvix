namespace Solvix.Mesh;

/// <summary>
/// The isoparametric geometry of one 20-node hex given only its 20 node positions
/// (slot order, see <see cref="Hex20Reference"/>): independent of any mesh, so a cube
/// can be examined before it is placed anywhere.
/// </summary>
public static class Hex20Geometry
{
    private static readonly double[] GaussPoints = { -Math.Sqrt(0.6), 0, Math.Sqrt(0.6) };

    public static Vec3 Map(IReadOnlyList<Vec3> positions, Vec3 xi)
    {
        Span<double> phi = stackalloc double[Hex20Reference.NodeCount];
        Hex20Reference.ShapeFunctions(xi.X, xi.Y, xi.Z, phi);
        var point = Vec3.Zero;
        for (int i = 0; i < Hex20Reference.NodeCount; i++) point += positions[i] * phi[i];
        return point;
    }

    /// <summary>J[r, c] = d x_r / d xi_c.</summary>
    public static double[,] Jacobian(IReadOnlyList<Vec3> positions, Vec3 xi)
    {
        var dPhi = new double[Hex20Reference.NodeCount, 3];
        Hex20Reference.ShapeDerivatives(xi.X, xi.Y, xi.Z, dPhi);
        var j = new double[3, 3];
        for (int i = 0; i < Hex20Reference.NodeCount; i++)
        {
            var p = positions[i];
            for (int c = 0; c < 3; c++)
            {
                j[0, c] += dPhi[i, c] * p.X;
                j[1, c] += dPhi[i, c] * p.Y;
                j[2, c] += dPhi[i, c] * p.Z;
            }
        }
        return j;
    }

    public static double Determinant(double[,] m) =>
        m[0, 0] * (m[1, 1] * m[2, 2] - m[1, 2] * m[2, 1])
        - m[0, 1] * (m[1, 0] * m[2, 2] - m[1, 2] * m[2, 0])
        + m[0, 2] * (m[1, 0] * m[2, 1] - m[1, 1] * m[2, 0]);

    /// <summary>
    /// Smallest Jacobian determinant over the 27 Gauss points (what the solver
    /// integrates with) and the 20 nodes. Positive means the map is a valid
    /// one-to-one image of the cube; non-positive means folded or degenerate.
    /// </summary>
    public static double MinDeterminant(IReadOnlyList<Vec3> positions) => DeterminantRange(positions).Min;

    /// <summary>The smallest and the largest Jacobian determinant over the same 47 points: how uneven the cube's map is.</summary>
    public static (double Min, double Max) DeterminantRange(IReadOnlyList<Vec3> positions)
    {
        // The derivatives of the shape functions at the 47 fixed points are tabulated once: a cube is checked many
        // times (smoothing, quality), and only the node positions differ between the checks.
        Span<double> x = stackalloc double[Hex20Reference.NodeCount], y = stackalloc double[Hex20Reference.NodeCount], z = stackalloc double[Hex20Reference.NodeCount];
        for (int i = 0; i < Hex20Reference.NodeCount; i++)
        {
            var p = positions[i];
            x[i] = p.X; y[i] = p.Y; z[i] = p.Z;
        }
        double min = double.MaxValue, max = double.MinValue;
        foreach (var d in CheckPoints)
        {
            double j00 = 0, j01 = 0, j02 = 0, j10 = 0, j11 = 0, j12 = 0, j20 = 0, j21 = 0, j22 = 0;
            for (int i = 0; i < Hex20Reference.NodeCount; i++)
            {
                double da = d[3 * i], db = d[3 * i + 1], dg = d[3 * i + 2];
                j00 += da * x[i]; j01 += db * x[i]; j02 += dg * x[i];
                j10 += da * y[i]; j11 += db * y[i]; j12 += dg * y[i];
                j20 += da * z[i]; j21 += db * z[i]; j22 += dg * z[i];
            }
            double det = j00 * (j11 * j22 - j12 * j21) - j01 * (j10 * j22 - j12 * j20) + j02 * (j10 * j21 - j11 * j20);
            if (det < min) min = det;
            if (det > max) max = det;
        }
        return (min, max);
    }

    /// <summary>The same as <see cref="MinDeterminant"/> computed point by point, with no tables: for checking it.</summary>
    public static double MinDeterminantDirect(IReadOnlyList<Vec3> positions)
    {
        double min = double.MaxValue;
        foreach (double a in GaussPoints)
            foreach (double b in GaussPoints)
                foreach (double g in GaussPoints)
                    min = Math.Min(min, Determinant(Jacobian(positions, new Vec3(a, b, g))));
        for (int s = 0; s < Hex20Reference.NodeCount; s++)
            min = Math.Min(min, Determinant(Jacobian(positions, new Vec3(Hex20Reference.LocalCoords[s, 0], Hex20Reference.LocalCoords[s, 1], Hex20Reference.LocalCoords[s, 2]))));
        return min;
    }

    // dPhi at the 27 Gauss points and the 20 nodes, each flattened as [slot * 3 + axis]
    private static readonly double[][] CheckPoints = BuildCheckPoints();

    private static double[][] BuildCheckPoints()
    {
        var points = new List<double[]>();
        void Add(double a, double b, double g)
        {
            var table = new double[Hex20Reference.NodeCount, 3];
            Hex20Reference.ShapeDerivatives(a, b, g, table);
            var flat = new double[Hex20Reference.NodeCount * 3];
            for (int i = 0; i < Hex20Reference.NodeCount; i++)
                for (int c = 0; c < 3; c++) flat[3 * i + c] = table[i, c];
            points.Add(flat);
        }
        foreach (double a in GaussPoints)
            foreach (double b in GaussPoints)
                foreach (double g in GaussPoints) Add(a, b, g);
        for (int s = 0; s < Hex20Reference.NodeCount; s++) Add(Hex20Reference.LocalCoords[s, 0], Hex20Reference.LocalCoords[s, 1], Hex20Reference.LocalCoords[s, 2]);
        return points.ToArray();
    }
}
