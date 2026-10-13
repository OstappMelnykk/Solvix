namespace Solvix.Fem;

public enum QualityGrade { Excellent, Good, Acceptable, Poor, Invalid }

/// <summary>How well an element can be integrated: the usual measures of a curved hexahedron's quality.</summary>
/// <param name="ScaledJacobian">Min over the corners and Gauss points of detJ / (|g1||g2||g3|) (Knupp): 1 for a box, 0 when degenerate, negative when folded.</param>
/// <param name="JacobianRatio">Min detJ / max detJ over the same points: how unevenly the element stretches space (1 = uniformly).</param>
/// <param name="AspectRatio">Longest / shortest edge (the edge length through its midpoint).</param>
/// <param name="MaxSkewDegrees">Largest deviation from 90 degrees of any angle (see <see cref="ElementQuality.Of"/>): the face corner angles and the dihedral angles between faces.</param>
/// <param name="MinAngleDegrees">The smallest of those angles.</param>
/// <param name="MaxAngleDegrees">The largest of those angles.</param>
/// <param name="GaussJacobianRatio">Min detJ / max detJ over the Gauss points only (the corners left out), as HyperMesh reports its Jacobian.</param>
public readonly record struct ElementQualityMetrics(double MinDeterminant, double ScaledJacobian, double JacobianRatio, double AspectRatio, double MaxSkewDegrees, double MinAngleDegrees = 90, double MaxAngleDegrees = 90, double GaussJacobianRatio = 1)
{
    /// <summary>
    /// The grade: invalid when folded or degenerate; otherwise the worse of the grades of the scaled Jacobian,
    /// the Jacobian ratio, the aspect ratio and the angles. Limits are rules of thumb for quadratic hexahedra:
    /// scaled J &gt; 0.7 / 0.4 / 0.15, J ratio &gt; 0.5 / 0.2 / 0.05, aspect &lt; 3 / 10 / 30, and the angles within
    /// 30 / 45 / 75 degrees of a right angle (60-120 excellent, 45-135 good, 15-165 acceptable, otherwise poor).
    /// </summary>
    public QualityGrade Grade
    {
        get
        {
            if (!(MinDeterminant > 0) || !(ScaledJacobian > 0)) return QualityGrade.Invalid;
            var j = ElementQuality.GradeAbove(ScaledJacobian, ElementQuality.ScaledJacobianLimits);
            var r = ElementQuality.GradeAbove(JacobianRatio, ElementQuality.JacobianRatioLimits);
            var a = ElementQuality.GradeBelow(AspectRatio, ElementQuality.AspectRatioLimits);
            var k = ElementQuality.GradeBelow(MaxSkewDegrees, ElementQuality.SkewLimits);
            return (QualityGrade)Math.Max(Math.Max((int)j, (int)r), Math.Max((int)a, (int)k));
        }
    }
}

public static class ElementQuality
{
    // The limits between excellent | good | acceptable | poor, for the grade and for showing them to the user.
    public static readonly double[] ScaledJacobianLimits = { 0.7, 0.4, 0.15 };
    public static readonly double[] JacobianRatioLimits = { 0.5, 0.2, 0.05 };
    public static readonly double[] AspectRatioLimits = { 3, 10, 30 };
    // The largest deviation of an angle from 90 degrees: within 30 (angles 60-120) excellent, within 45 (45-135) good,
    // within 75 (15-165) acceptable, beyond that poor.
    public static readonly double[] SkewLimits = { 30, 45, 75 };

    // Larger is better (scaled Jacobian, Jacobian ratio): above the first limit excellent, ... below the last poor.
    public static QualityGrade GradeAbove(double value, double[] limits) =>
        value > limits[0] ? QualityGrade.Excellent : value > limits[1] ? QualityGrade.Good : value > limits[2] ? QualityGrade.Acceptable : QualityGrade.Poor;

    // Smaller is better (aspect ratio, skew).
    public static QualityGrade GradeBelow(double value, double[] limits) =>
        value < limits[0] ? QualityGrade.Excellent : value < limits[1] ? QualityGrade.Good : value < limits[2] ? QualityGrade.Acceptable : QualityGrade.Poor;

    // the 12 edges as (corner, midpoint, corner)
    private static readonly (int, int, int)[] Edges =
    {
        (0, 8, 1), (1, 9, 2), (2, 10, 3), (3, 11, 0), (4, 12, 5), (5, 13, 6), (6, 14, 7), (7, 15, 4), (0, 16, 4), (1, 17, 5), (2, 18, 6), (3, 19, 7),
    };

    public static ElementQualityMetrics Of(double[,] xyz)
    {
        var gradient = new double[Hex20.Nodes, 3];
        var local = new double[Hex20.Nodes, 3];
        double minDet = double.MaxValue, maxDet = double.MinValue, minScaled = double.MaxValue, gaussMin = double.MaxValue, gaussMax = double.MinValue;

        void Sample(double a, double b, double g, bool gauss)
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
            if (gauss) { gaussMin = Math.Min(gaussMin, det); gaussMax = Math.Max(gaussMax, det); }
        }
        foreach (double a in Hex20.GaussPoints) foreach (double b in Hex20.GaussPoints) foreach (double g in Hex20.GaussPoints) Sample(a, b, g, true);
        for (int n = 0; n < 8; n++) Sample(Hex20.Local[n, 0], Hex20.Local[n, 1], Hex20.Local[n, 2], false);

        double shortest = double.MaxValue, longest = 0;
        foreach (var (a, m, b) in Edges)
        {
            double len = Distance(xyz, a, m) + Distance(xyz, m, b);
            shortest = Math.Min(shortest, len); longest = Math.Max(longest, len);
        }
        // Angles. At each corner the three edges leave along the tangents of the curved edges (the quadratic edge
        // through its midpoint), so a bent edge counts as bent. From the three tangents come the three face corner
        // angles (between two edges, which is the angle of the face there) and the three dihedral angles (between two
        // faces along an edge: the angle between the other two edges seen across the first). Together 24 + 24 angles.
        double minAngle = 180, maxAngle = 0;
        var tangents = new double[3][];
        for (int corner = 0; corner < 8; corner++)
        {
            int count = 0;
            foreach (var (a, m, b) in Edges)
            {
                if (a != corner && b != corner) continue;
                tangents[count++] = a == corner ? Tangent(xyz, a, m, b, -1.5, 2, -0.5) : Tangent(xyz, a, m, b, -0.5, 2, -1.5);
            }
            for (int i = 0; i < 3; i++)
            {
                int j = (i + 1) % 3, k = (i + 2) % 3;
                var face = Angle(tangents[i], tangents[j]);
                // the dihedral along edge i: the angle between the parts of the other two tangents that are across edge i
                var dihedral = Angle(Across(tangents[j], tangents[i]), Across(tangents[k], tangents[i]));
                foreach (double angle in new[] { face, dihedral })
                {
                    if (double.IsNaN(angle)) continue;
                    minAngle = Math.Min(minAngle, angle); maxAngle = Math.Max(maxAngle, angle);
                }
            }
        }
        double skew = maxAngle >= minAngle ? Math.Max(90 - minAngle, maxAngle - 90) : 0;
        double ratio = maxDet > 0 ? minDet / maxDet : 0;
        return new ElementQualityMetrics(minDet, minScaled, ratio, shortest > 0 ? longest / shortest : double.PositiveInfinity, skew, maxAngle >= minAngle ? minAngle : 90, maxAngle >= minAngle ? maxAngle : 90, gaussMax > 0 ? gaussMin / gaussMax : 0);
    }

    // Tangent of the quadratic edge (a, m, b) leaving the corner: the derivative of the edge at the end, with the
    // weights of its three nodes.
    private static double[] Tangent(double[,] xyz, int a, int m, int b, double wa, double wm, double wb)
    {
        var t = new double[3];
        for (int c = 0; c < 3; c++) t[c] = wa * xyz[a, c] + wm * xyz[m, c] + wb * xyz[b, c];
        return t;
    }

    // `v` without its part along `axis`.
    private static double[] Across(double[] v, double[] axis)
    {
        double dot = 0, len = 0;
        for (int c = 0; c < 3; c++) { dot += v[c] * axis[c]; len += axis[c] * axis[c]; }
        var r = new double[3];
        for (int c = 0; c < 3; c++) r[c] = len > 0 ? v[c] - dot / len * axis[c] : v[c];
        return r;
    }

    // The angle between two vectors in degrees (NaN when one has no length).
    private static double Angle(double[] u, double[] v)
    {
        double dot = 0, lu = 0, lv = 0;
        for (int c = 0; c < 3; c++) { dot += u[c] * v[c]; lu += u[c] * u[c]; lv += v[c] * v[c]; }
        return lu > 1e-300 && lv > 1e-300 ? Math.Acos(Math.Clamp(dot / Math.Sqrt(lu * lv), -1, 1)) * 180 / Math.PI : double.NaN;
    }

    private static double Distance(double[,] xyz, int a, int b)
    {
        double s = 0;
        for (int c = 0; c < 3; c++) s += (xyz[a, c] - xyz[b, c]) * (xyz[a, c] - xyz[b, c]);
        return Math.Sqrt(s);
    }
}
