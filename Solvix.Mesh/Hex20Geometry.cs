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
    public static double MinDeterminant(IReadOnlyList<Vec3> positions)
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
}
