namespace Solvix.FemMesh;

/// <summary>The 20-node hexahedron the solver uses: where the nodes are in the element's own coordinates, its faces and its shape functions.</summary>
public static class ElementLocal
{
    /// <summary>Local (alpha, beta, gamma) of the 20 nodes: corners, then edge midpoints, as in the solver.</summary>
    public static readonly int[,] Nodes =
    {
        { -1, -1, -1 }, { +1, -1, -1 }, { +1, +1, -1 }, { -1, +1, -1 },
        { -1, -1, +1 }, { +1, -1, +1 }, { +1, +1, +1 }, { -1, +1, +1 },
        {  0, -1, -1 }, { +1,  0, -1 }, {  0, +1, -1 }, { -1,  0, -1 },
        {  0, -1, +1 }, { +1,  0, +1 }, {  0, +1, +1 }, { -1,  0, +1 },
        { -1, -1,  0 }, { +1, -1,  0 }, { +1, +1,  0 }, { -1, +1,  0 },
    };

    /// <summary>The editor's name of each solver face index: 0 bottom = ZMinus, 1 top = ZPlus, 2 front = YMinus, 3 back = YPlus, 4 left = XMinus, 5 right = XPlus.</summary>
    public static readonly string[] FaceNames = { "ZMinus", "ZPlus", "YMinus", "YPlus", "XMinus", "XPlus" };

    /// <summary>The axis (0 x, 1 y, 2 z) a solver face is perpendicular to, and which end of it: -1 or +1.</summary>
    public static (int Axis, int Sign) FaceAxis(int face) => (face / 2 == 0 ? 2 : face / 2 == 1 ? 1 : 0, face % 2 == 0 ? -1 : 1);

    /// <summary>The solver face index of an editor face name, or -1.</summary>
    public static int FaceOf(string name) => Array.IndexOf(FaceNames, name);

    /// <summary>The 8 nodes (4 corners, 4 midpoints) on each face, by solver face index.</summary>
    public static readonly int[][] FaceNodes = Enumerable.Range(0, 6).Select(f =>
    {
        var (axis, sign) = FaceAxis(f);
        return Enumerable.Range(0, 20).Where(n => Nodes[n, axis] == sign).ToArray();
    }).ToArray();

    /// <summary>The 20 serendipity shape functions at (a, b, g).</summary>
    public static double[] ShapeFunctions(double a, double b, double g)
    {
        var phi = new double[20];
        for (int i = 0; i < 8; i++)
        {
            double ai = Nodes[i, 0], bi = Nodes[i, 1], gi = Nodes[i, 2];
            phi[i] = 0.125 * (1 + ai * a) * (1 + bi * b) * (1 + gi * g) * (ai * a + bi * b + gi * g - 2);
        }
        for (int i = 8; i < 20; i++)
        {
            double ai = Nodes[i, 0], bi = Nodes[i, 1], gi = Nodes[i, 2];
            phi[i] = 0.25 * (ai == 0 ? 1 - a * a : 1 + ai * a) * (bi == 0 ? 1 - b * b : 1 + bi * b) * (gi == 0 ? 1 - g * g : 1 + gi * g);
        }
        return phi;
    }
}
