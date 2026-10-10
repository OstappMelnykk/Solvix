namespace Solvix.Fem;

public enum QualityGrade { Excellent, Good, Acceptable, Poor, Invalid }

/// <summary>How well an element can be integrated: the usual measures of a curved hexahedron's quality.</summary>
/// <param name="ScaledJacobian">Min over the corners and Gauss points of detJ / (|g1||g2||g3|) (Knupp): 1 for a box, 0 when degenerate, negative when folded.</param>
/// <param name="JacobianRatio">Min detJ / max detJ over the same points: how unevenly the element stretches space (1 = uniformly).</param>
/// <param name="AspectRatio">Longest / shortest edge (the edge length through its midpoint).</param>
/// <param name="MaxSkewDegrees">Largest deviation of a corner angle between edges from 90 degrees.</param>
public readonly record struct ElementQualityMetrics(double MinDeterminant, double ScaledJacobian, double JacobianRatio, double AspectRatio, double MaxSkewDegrees)
{
    /// <summary>
    /// The grade: invalid when folded or degenerate; otherwise the worse of the grades of the scaled Jacobian,
    /// the Jacobian ratio and the aspect ratio. Limits follow common practice (ANSYS/Abaqus/Altair guidance for
    /// quadratic hexahedra): scaled J &gt; 0.7 / 0.4 / 0.15, J ratio &gt; 0.5 / 0.2 / 0.05, aspect &lt; 3 / 10 / 30.
    /// </summary>
    public QualityGrade Grade
    {
        get
        {
            if (!(MinDeterminant > 0) || !(ScaledJacobian > 0)) return QualityGrade.Invalid;
            var j = ScaledJacobian > 0.7 ? QualityGrade.Excellent : ScaledJacobian > 0.4 ? QualityGrade.Good : ScaledJacobian > 0.15 ? QualityGrade.Acceptable : QualityGrade.Poor;
            var r = JacobianRatio > 0.5 ? QualityGrade.Excellent : JacobianRatio > 0.2 ? QualityGrade.Good : JacobianRatio > 0.05 ? QualityGrade.Acceptable : QualityGrade.Poor;
            var a = AspectRatio < 3 ? QualityGrade.Excellent : AspectRatio < 10 ? QualityGrade.Good : AspectRatio < 30 ? QualityGrade.Acceptable : QualityGrade.Poor;
            return (QualityGrade)Math.Max((int)j, Math.Max((int)r, (int)a));
        }
    }
}

public static class ElementQuality
{
    // the 12 edges as (corner, midpoint, corner)
    private static readonly (int, int, int)[] Edges =
    {
        (0, 8, 1), (1, 9, 2), (2, 10, 3), (3, 11, 0), (4, 12, 5), (5, 13, 6), (6, 14, 7), (7, 15, 4), (0, 16, 4), (1, 17, 5), (2, 18, 6), (3, 19, 7),
    };

    public static ElementQualityMetrics Of(double[,] xyz)
    {
        var gradient = new double[Hex20.Nodes, 3];
        var local = new double[Hex20.Nodes, 3];
        double minDet = double.MaxValue, maxDet = double.MinValue, minScaled = double.MaxValue;

        void Sample(double a, double b, double g)
        {
            Hex20.Derivatives(a, b, g, local);
            var j = new double[3, 3];
            for (int i = 0; i < Hex20.Nodes; i++)
                for (int m = 0; m < 3; m++)
                    for (int n = 0; n < 3; n++) j[m, n] += local[i, n] * xyz[i, m];
            double det = j[0, 0] * (j[1, 1] * j[2, 2] - j[1, 2] * j[2, 1]) - j[0, 1] * (j[1, 0] * j[2, 2] - j[1, 2] * j[2, 0]) + j[0, 2] * (j[1, 0] * j[2, 1] - j[1, 1] * j[2, 0]);
            double l0 = Math.Sqrt(j[0, 0] * j[0, 0] + j[1, 0] * j[1, 0] + j[2, 0] * j[2, 0]);
            double l1 = Math.Sqrt(j[0, 1] * j[0, 1] + j[1, 1] * j[1, 1] + j[2, 1] * j[2, 1]);
            double l2 = Math.Sqrt(j[0, 2] * j[0, 2] + j[1, 2] * j[1, 2] + j[2, 2] * j[2, 2]);
            double scaled = l0 * l1 * l2 > 0 ? det / (l0 * l1 * l2) : 0;
            minDet = Math.Min(minDet, det); maxDet = Math.Max(maxDet, det); minScaled = Math.Min(minScaled, scaled);
        }
        foreach (double a in Hex20.GaussPoints) foreach (double b in Hex20.GaussPoints) foreach (double g in Hex20.GaussPoints) Sample(a, b, g);
        for (int n = 0; n < 8; n++) Sample(Hex20.Local[n, 0], Hex20.Local[n, 1], Hex20.Local[n, 2]);

        double shortest = double.MaxValue, longest = 0;
        foreach (var (a, m, b) in Edges)
        {
            double len = Distance(xyz, a, m) + Distance(xyz, m, b);
            shortest = Math.Min(shortest, len); longest = Math.Max(longest, len);
        }
        double skew = 0;
        for (int corner = 0; corner < 8; corner++)
        {
            var edges = Edges.Where(e => e.Item1 == corner || e.Item3 == corner).ToArray();
            for (int i = 0; i < edges.Length; i++)
                for (int k = i + 1; k < edges.Length; k++)
                {
                    int ai = edges[i].Item1 == corner ? edges[i].Item3 : edges[i].Item1;
                    int bi = edges[k].Item1 == corner ? edges[k].Item3 : edges[k].Item1;
                    double dot = 0, la = 0, lb = 0;
                    for (int c = 0; c < 3; c++)
                    {
                        double u = xyz[ai, c] - xyz[corner, c], v = xyz[bi, c] - xyz[corner, c];
                        dot += u * v; la += u * u; lb += v * v;
                    }
                    if (la == 0 || lb == 0) continue;
                    double angle = Math.Acos(Math.Clamp(dot / Math.Sqrt(la * lb), -1, 1)) * 180 / Math.PI;
                    skew = Math.Max(skew, Math.Abs(angle - 90));
                }
        }
        double ratio = maxDet > 0 ? minDet / maxDet : 0;
        return new ElementQualityMetrics(minDet, minScaled, ratio, shortest > 0 ? longest / shortest : double.PositiveInfinity, skew);
    }

    private static double Distance(double[,] xyz, int a, int b)
    {
        double s = 0;
        for (int c = 0; c < 3; c++) s += (xyz[a, c] - xyz[b, c]) * (xyz[a, c] - xyz[b, c]);
        return Math.Sqrt(s);
    }
}
