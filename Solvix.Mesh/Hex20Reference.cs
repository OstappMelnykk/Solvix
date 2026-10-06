namespace Solvix.Mesh;

/// <summary>
/// Reference 20-node serendipity hexahedron on [-1,1]^3: node layout, shape
/// functions and their derivatives. The same functions drive both the
/// isoparametric geometry map (CAD side) and the FEM solver, so the node
/// order here MUST match the solver's: 0..7 corners, 8..19 edge midpoints.
/// </summary>
public static class Hex20Reference
{
    public const int NodeCount = 20;
    public const int CornerCount = 8;

    /// <summary>LocalCoords[slot, axis] in {-1, 0, +1}; axis 0=alpha, 1=beta, 2=gamma.</summary>
    public static readonly int[,] LocalCoords =
    {
        { -1, -1, -1 }, { +1, -1, -1 }, { +1, +1, -1 }, { -1, +1, -1 },
        { -1, -1, +1 }, { +1, -1, +1 }, { +1, +1, +1 }, { -1, +1, +1 },
        {  0, -1, -1 }, { +1,  0, -1 }, {  0, +1, -1 }, { -1,  0, -1 },
        {  0, -1, +1 }, { +1,  0, +1 }, {  0, +1, +1 }, { -1,  0, +1 },
        { -1, -1,  0 }, { +1, -1,  0 }, { +1, +1,  0 }, { -1, +1,  0 },
    };

    /// <summary>Corner pair of each edge; edge k carries the midpoint node 8 + k.</summary>
    public static readonly (int A, int B)[] EdgeCorners =
    {
        (0, 1), (1, 2), (2, 3), (3, 0),
        (4, 5), (5, 6), (6, 7), (7, 4),
        (0, 4), (1, 5), (2, 6), (3, 7),
    };

    public static bool IsCorner(int slot) => slot < CornerCount;

    public static void ShapeFunctions(double a, double b, double g, Span<double> phi)
    {
        for (int i = 0; i < 8; i++)
        {
            double ai = LocalCoords[i, 0], bi = LocalCoords[i, 1], ci = LocalCoords[i, 2];
            phi[i] = (1.0 / 8.0) * (1 + a * ai) * (1 + b * bi) * (1 + g * ci) * (a * ai + b * bi + g * ci - 2);
        }
        for (int i = 8; i < 20; i++)
        {
            double ai = LocalCoords[i, 0], bi = LocalCoords[i, 1], ci = LocalCoords[i, 2];
            if (ai == 0) phi[i] = 0.25 * (1 - a * a) * (1 + b * bi) * (1 + g * ci);
            else if (bi == 0) phi[i] = 0.25 * (1 + a * ai) * (1 - b * b) * (1 + g * ci);
            else phi[i] = 0.25 * (1 + a * ai) * (1 + b * bi) * (1 - g * g);
        }
    }

    /// <summary>dPhi[slot, axis] = d(phi_slot)/d(local axis).</summary>
    public static void ShapeDerivatives(double a, double b, double g, double[,] dPhi)
    {
        for (int i = 0; i < 8; i++)
        {
            double ai = LocalCoords[i, 0], bi = LocalCoords[i, 1], ci = LocalCoords[i, 2];
            dPhi[i, 0] = (1.0 / 8.0) * ai * (1 + b * bi) * (1 + g * ci) * (2 * a * ai + b * bi + g * ci - 1);
            dPhi[i, 1] = (1.0 / 8.0) * bi * (1 + a * ai) * (1 + g * ci) * (a * ai + 2 * b * bi + g * ci - 1);
            dPhi[i, 2] = (1.0 / 8.0) * ci * (1 + a * ai) * (1 + b * bi) * (a * ai + b * bi + 2 * g * ci - 1);
        }
        for (int i = 8; i < 20; i++)
        {
            double ai = LocalCoords[i, 0], bi = LocalCoords[i, 1], ci = LocalCoords[i, 2];
            if (ai == 0)
            {
                dPhi[i, 0] = 0.25 * (-2 * a) * (1 + b * bi) * (1 + g * ci);
                dPhi[i, 1] = 0.25 * (1 - a * a) * bi * (1 + g * ci);
                dPhi[i, 2] = 0.25 * (1 - a * a) * (1 + b * bi) * ci;
            }
            else if (bi == 0)
            {
                dPhi[i, 0] = 0.25 * ai * (1 - b * b) * (1 + g * ci);
                dPhi[i, 1] = 0.25 * (1 + a * ai) * (-2 * b) * (1 + g * ci);
                dPhi[i, 2] = 0.25 * (1 + a * ai) * (1 - b * b) * ci;
            }
            else
            {
                dPhi[i, 0] = 0.25 * ai * (1 + b * bi) * (1 - g * g);
                dPhi[i, 1] = 0.25 * (1 + a * ai) * bi * (1 - g * g);
                dPhi[i, 2] = 0.25 * (1 + a * ai) * (1 + b * bi) * (-2 * g);
            }
        }
    }
}
