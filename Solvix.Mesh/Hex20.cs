namespace Solvix.Mesh;

/// <summary>
/// One curvilinear 20-node hexahedron. Its 8 corner slots are the cube
/// primitive; slots 8..19 are the edge midpoints. Nodes are shared with
/// linked neighbours, so a hex only stores node ids - positions live in the
/// mesh. The ideal-world image of the hex is the unit lattice cell
/// <see cref="Cell"/>.
/// </summary>
public sealed class Hex20
{
    private readonly HexMesh _mesh;

    internal Hex20(HexMesh mesh, int id, (int I, int J, int K) cell)
    {
        _mesh = mesh;
        Id = id;
        Cell = cell;
    }

    public int Id { get; }
    public (int I, int J, int K) Cell { get; }

    /// <summary>Reserved for local refinement: the hex this one was split from.</summary>
    public int? ParentId { get; internal set; }

    public int[] NodeIds { get; } = new int[Hex20Reference.NodeCount];

    /// <summary>The 8-corner cube primitive (real positions).</summary>
    public Vec3[] Corners() => Enumerable.Range(0, Hex20Reference.CornerCount).Select(s => _mesh.Node(NodeIds[s]).Position).ToArray();

    /// <summary>Isoparametric map from the reference cube [-1,1]^3 to real space.</summary>
    public Vec3 Map(Vec3 xi)
    {
        Span<double> phi = stackalloc double[Hex20Reference.NodeCount];
        Hex20Reference.ShapeFunctions(xi.X, xi.Y, xi.Z, phi);
        Vec3 p = Vec3.Zero;
        for (int i = 0; i < Hex20Reference.NodeCount; i++) p += _mesh.Node(NodeIds[i]).Position * phi[i];
        return p;
    }

    /// <summary>J[r, c] = d x_r / d xi_c.</summary>
    public double[,] Jacobian(Vec3 xi)
    {
        var dPhi = new double[Hex20Reference.NodeCount, 3];
        Hex20Reference.ShapeDerivatives(xi.X, xi.Y, xi.Z, dPhi);
        var j = new double[3, 3];
        for (int i = 0; i < Hex20Reference.NodeCount; i++)
        {
            var p = _mesh.Node(NodeIds[i]).Position;
            for (int c = 0; c < 3; c++)
            {
                j[0, c] += dPhi[i, c] * p.X;
                j[1, c] += dPhi[i, c] * p.Y;
                j[2, c] += dPhi[i, c] * p.Z;
            }
        }
        return j;
    }

    public double Determinant(Vec3 xi) => Det(Jacobian(xi));

    private static readonly double[] GaussPoints = { -Math.Sqrt(0.6), 0, Math.Sqrt(0.6) };

    /// <summary>
    /// Smallest Jacobian determinant over the 27 Gauss points (what the solver
    /// integrates with) and the 20 nodes. The isoparametric map is a valid
    /// one-to-one image of the cube only while this stays positive; a
    /// non-positive value means the hex is folded or degenerate.
    /// </summary>
    public double MinDeterminant()
    {
        double min = double.MaxValue;
        foreach (double a in GaussPoints)
            foreach (double b in GaussPoints)
                foreach (double g in GaussPoints)
                    min = Math.Min(min, Determinant(new Vec3(a, b, g)));
        for (int s = 0; s < Hex20Reference.NodeCount; s++)
            min = Math.Min(min, Determinant(new Vec3(Hex20Reference.LocalCoords[s, 0], Hex20Reference.LocalCoords[s, 1], Hex20Reference.LocalCoords[s, 2])));
        return min;
    }

    public bool IsValid(double minDeterminant = 1e-9) => MinDeterminant() > minDeterminant;

    /// <summary>Axis-aligned box that safely contains the hex (padded: edge midpoints can bulge past the corners).</summary>
    public (Vec3 Min, Vec3 Max) Bounds()
    {
        var min = new Vec3(double.MaxValue, double.MaxValue, double.MaxValue);
        var max = new Vec3(double.MinValue, double.MinValue, double.MinValue);
        foreach (int id in NodeIds)
        {
            var p = _mesh.Node(id).Position;
            min = new Vec3(Math.Min(min.X, p.X), Math.Min(min.Y, p.Y), Math.Min(min.Z, p.Z));
            max = new Vec3(Math.Max(max.X, p.X), Math.Max(max.Y, p.Y), Math.Max(max.Z, p.Z));
        }
        var pad = (max - min) * 0.25;
        return (min - pad, max + pad);
    }

    /// <summary>Inverse of <see cref="Map"/> by Newton iteration; false if it does not converge.</summary>
    public bool TryInvertMap(Vec3 target, out Vec3 xi, double tolerance = 1e-10, int maxIterations = 60) =>
        TryInvertMap(target, Vec3.Zero, out xi, tolerance, maxIterations);

    public bool TryInvertMap(Vec3 target, Vec3 start, out Vec3 xi, double tolerance = 1e-10, int maxIterations = 60)
    {
        xi = start;
        for (int iter = 0; iter < maxIterations; iter++)
        {
            Vec3 residual = Map(xi) - target;
            if (residual.Length < tolerance) return true;
            var j = Jacobian(xi);
            double det = Det(j);
            if (Math.Abs(det) < 1e-14) return false;
            xi -= Solve(j, det, residual);
            if (double.IsNaN(xi.X) || double.IsNaN(xi.Y) || double.IsNaN(xi.Z)) return false;
        }
        return (Map(xi) - target).Length < tolerance;
    }

    private static double Det(double[,] m) =>
        m[0, 0] * (m[1, 1] * m[2, 2] - m[1, 2] * m[2, 1])
        - m[0, 1] * (m[1, 0] * m[2, 2] - m[1, 2] * m[2, 0])
        + m[0, 2] * (m[1, 0] * m[2, 1] - m[1, 1] * m[2, 0]);

    // Cramer's rule for J * x = r.
    private static Vec3 Solve(double[,] m, double det, Vec3 r)
    {
        double Replace(int col)
        {
            var t = (double[,])m.Clone();
            t[0, col] = r.X; t[1, col] = r.Y; t[2, col] = r.Z;
            return Det(t) / det;
        }
        return new Vec3(Replace(0), Replace(1), Replace(2));
    }
}
