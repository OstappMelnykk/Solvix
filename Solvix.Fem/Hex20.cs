namespace Solvix.Fem;

/// <summary>
/// The 20-node serendipity hexahedron on the reference cube [-1, 1]^3: node layout, shape functions, their
/// derivatives and the Gauss rules. Nodes 0..7 are the corners, 8..19 the edge midpoints (the same numbering as
/// the mesh editor's Hex20Reference - Solvix.Mesh.Tests checks the two agree).
/// </summary>
public static class Hex20
{
    public const int Nodes = 20;
    public const int Dofs = 60;

    /// <summary>Local (alpha, beta, gamma) of each node.</summary>
    public static readonly int[,] Local =
    {
        { -1, -1, -1 }, { +1, -1, -1 }, { +1, +1, -1 }, { -1, +1, -1 },
        { -1, -1, +1 }, { +1, -1, +1 }, { +1, +1, +1 }, { -1, +1, +1 },
        {  0, -1, -1 }, { +1,  0, -1 }, {  0, +1, -1 }, { -1,  0, -1 },
        {  0, -1, +1 }, { +1,  0, +1 }, {  0, +1, +1 }, { -1,  0, +1 },
        { -1, -1,  0 }, { +1, -1,  0 }, { +1, +1,  0 }, { -1, +1,  0 },
    };

    /// <summary>Three-point Gauss rule on [-1, 1]: exact for polynomials up to degree 5 along each axis.</summary>
    public static readonly double[] GaussPoints = { -Math.Sqrt(0.6), 0.0, Math.Sqrt(0.6) };
    public static readonly double[] GaussWeights = { 5.0 / 9.0, 8.0 / 9.0, 5.0 / 9.0 };

    /// <summary>Shape functions at (a, b, g).</summary>
    public static void Shape(double a, double b, double g, Span<double> phi)
    {
        for (int i = 0; i < Nodes; i++)
        {
            double ai = Local[i, 0], bi = Local[i, 1], gi = Local[i, 2];
            if (i < 8) phi[i] = 0.125 * (1 + ai * a) * (1 + bi * b) * (1 + gi * g) * (ai * a + bi * b + gi * g - 2);
            else phi[i] = 0.25 * Factor(ai, a) * Factor(bi, b) * Factor(gi, g);
        }
    }

    // (1 - t^2) on the axis where the node is at the middle, (1 + t_i t) on the others.
    private static double Factor(double ti, double t) => ti == 0 ? 1 - t * t : 1 + ti * t;

    /// <summary>d phi_i / d (a, b, g) at (a, b, g): d[i, 0..2].</summary>
    public static void Derivatives(double a, double b, double g, double[,] d)
    {
        for (int i = 0; i < Nodes; i++)
        {
            double ai = Local[i, 0], bi = Local[i, 1], gi = Local[i, 2];
            if (i < 8)
            {
                double fa = 1 + ai * a, fb = 1 + bi * b, fg = 1 + gi * g, s = ai * a + bi * b + gi * g - 2;
                d[i, 0] = 0.125 * ai * fb * fg * (s + fa);
                d[i, 1] = 0.125 * bi * fa * fg * (s + fb);
                d[i, 2] = 0.125 * gi * fa * fb * (s + fg);
            }
            else
            {
                double fa = Factor(ai, a), fb = Factor(bi, b), fg = Factor(gi, g);
                d[i, 0] = 0.25 * (ai == 0 ? -2 * a : ai) * fb * fg;
                d[i, 1] = 0.25 * (bi == 0 ? -2 * b : bi) * fa * fg;
                d[i, 2] = 0.25 * (gi == 0 ? -2 * g : gi) * fa * fb;
            }
        }
    }

    /// <summary>
    /// The 8 nodes of each face (4 corners then 4 midpoints) ordered so that the cross product of the face's two
    /// tangents points outwards. Face indices follow the solver: 0 bottom (gamma=-1), 1 top (gamma=+1), 2 front
    /// (beta=-1), 3 back (beta=+1), 4 left (alpha=-1), 5 right (alpha=+1).
    /// </summary>
    public static readonly int[][] FaceNodes =
    {
        new[] { 0, 3, 2, 1, 11, 10, 9, 8 },
        new[] { 4, 5, 6, 7, 12, 13, 14, 15 },
        new[] { 0, 1, 5, 4, 8, 17, 12, 16 },
        new[] { 3, 7, 6, 2, 19, 14, 18, 10 },
        new[] { 0, 4, 7, 3, 16, 15, 19, 11 },
        new[] { 1, 2, 6, 5, 9, 18, 13, 17 },
    };

    // the 8-node face element: local (eta, tau) of its nodes, corners then midpoints
    private static readonly int[,] FaceLocal = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 }, { 0, -1 }, { 1, 0 }, { 0, 1 }, { -1, 0 } };

    public static void FaceShape(double eta, double tau, Span<double> psi)
    {
        for (int i = 0; i < 8; i++)
        {
            double e = FaceLocal[i, 0], t = FaceLocal[i, 1];
            if (i < 4) psi[i] = 0.25 * (1 + e * eta) * (1 + t * tau) * (e * eta + t * tau - 1);
            else if (e == 0) psi[i] = 0.5 * (1 - eta * eta) * (1 + t * tau);
            else psi[i] = 0.5 * (1 + e * eta) * (1 - tau * tau);
        }
    }

    public static void FaceDerivatives(double eta, double tau, double[,] d)
    {
        for (int i = 0; i < 8; i++)
        {
            double e = FaceLocal[i, 0], t = FaceLocal[i, 1];
            if (i < 4)
            {
                double s = e * eta + t * tau - 1;
                d[i, 0] = 0.25 * e * (1 + t * tau) * (s + 1 + e * eta);
                d[i, 1] = 0.25 * t * (1 + e * eta) * (s + 1 + t * tau);
            }
            else if (e == 0)
            {
                d[i, 0] = -eta * (1 + t * tau);
                d[i, 1] = 0.5 * (1 - eta * eta) * t;
            }
            else
            {
                d[i, 0] = 0.5 * e * (1 - tau * tau);
                d[i, 1] = -tau * (1 + e * eta);
            }
        }
    }
}
