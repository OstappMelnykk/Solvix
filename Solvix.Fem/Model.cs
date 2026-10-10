namespace Solvix.Fem;

/// <summary>A mesh of 20-node hexahedra with a material for every element.</summary>
public sealed class FemModel
{
    public FemModel(double[,] positions, int[,] connectivity, Material[] materials)
    {
        if (connectivity.GetLength(1) != Hex20.Nodes) throw new ArgumentException("Every element needs 20 nodes.");
        if (positions.GetLength(1) != 3) throw new ArgumentException("Positions must be n x 3.");
        if (materials.Length != connectivity.GetLength(0)) throw new ArgumentException("One material per element.");
        Positions = positions;
        Connectivity = connectivity;
        Materials = materials;
    }

    public double[,] Positions { get; }
    public int[,] Connectivity { get; }
    public Material[] Materials { get; }
    public int NodeCount => Positions.GetLength(0);
    public int ElementCount => Connectivity.GetLength(0);

    /// <summary>The 20 node positions of an element as a 20 x 3 array.</summary>
    public double[,] ElementNodes(int e)
    {
        var xyz = new double[Hex20.Nodes, 3];
        for (int i = 0; i < Hex20.Nodes; i++)
        {
            int node = Connectivity[e, i];
            for (int c = 0; c < 3; c++) xyz[i, c] = Positions[node, c];
        }
        return xyz;
    }

    public double[] ElementDisplacements(int e, double[] u)
    {
        var ue = new double[Hex20.Dofs];
        int n = NodeCount;
        for (int i = 0; i < Hex20.Nodes; i++)
        {
            int node = Connectivity[e, i];
            ue[i] = u[node]; ue[20 + i] = u[n + node]; ue[40 + i] = u[2 * n + node];
        }
        return ue;
    }
}

/// <summary>A face of an element: its index follows <see cref="Hex20.FaceNodes"/>.</summary>
public readonly record struct ElementFace(int Element, int Face);

public sealed record FacePressure(ElementFace Face, double Pn);

/// <summary>What acts on the body: the faces that are clamped (every node on them fixed) and the pressures.</summary>
public sealed class LoadCase
{
    public IReadOnlyCollection<ElementFace> Fixed { get; init; } = Array.Empty<ElementFace>();
    public IReadOnlyList<FacePressure> Pressures { get; init; } = Array.Empty<FacePressure>();
}

public sealed record FemSolution(
    double[] Displacements,
    double[,] Stress,
    double[] VonMises,
    int Iterations,
    double Residual,
    bool Converged);

public static class VonMisesStress
{
    public static double Of(double sxx, double syy, double szz, double sxy, double syz, double sxz) =>
        Math.Sqrt(0.5 * ((sxx - syy) * (sxx - syy) + (syy - szz) * (syy - szz) + (szz - sxx) * (szz - sxx) + 6 * (sxy * sxy + syz * syz + sxz * sxz)));
}
