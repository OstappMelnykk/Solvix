namespace Solvix.Fem;

/// <summary>
/// The shape checks that ANSYS Mechanical APDL applies to a brick with midside nodes (Theory Reference, 12.1 Element
/// Shape Testing), for the 20-node hexahedron: they are the documented criteria for exactly this element, so they are
/// Solvix's accept / reject measures. See docs/research/mesh-quality for the source and the numbers.
/// </summary>
/// <param name="JacobianRatio">Max / min of the Jacobian determinant over all 20 nodes and the centroid; -100 when they
/// differ in sign (the element is inverted somewhere). 1 for a brick whose faces are parallel and midside nodes are at
/// the average of their corners.</param>
/// <param name="AspectRatio">Worst, over the 6 faces and the 3 mid-sections, of the stretch of the rectangle built on the
/// bisectors of opposite edges (corner nodes only). 1 for a square.</param>
/// <param name="ParallelDeviation">Worst, over the faces and mid-sections, of the angle in degrees between a pair of
/// opposite edges (the larger of the two pairs; midside nodes ignored). 0 for a rectangle.</param>
/// <param name="MaxCornerAngle">Largest corner angle in degrees of any face or mid-section (corner nodes only). 90 for a rectangle.</param>
/// <param name="WarpingFactor">Largest over the 6 faces of the height difference along an edge (parallel to the mean
/// normal) divided by the square root of the projected area. 0 for flat faces.</param>
public readonly record struct BrickShape(double JacobianRatio, double AspectRatio, double ParallelDeviation, double MaxCornerAngle, double WarpingFactor)
{
    // the 6 faces as cycles of corner nodes
    private static readonly int[][] Faces =
    {
        new[] { 0, 1, 2, 3 }, new[] { 4, 5, 6, 7 }, new[] { 0, 1, 5, 4 }, new[] { 1, 2, 6, 5 }, new[] { 2, 3, 7, 6 }, new[] { 3, 0, 4, 7 },
    };

    // the 3 mid-sections, through the midside nodes of the edges that run across them (xi = 0, eta = 0, zeta = 0)
    private static readonly int[][] Sections = { new[] { 8, 10, 14, 12 }, new[] { 11, 9, 13, 15 }, new[] { 16, 17, 18, 19 } };

    public static BrickShape Of(double[,] xyz)
    {
        double[] P(int i) => new[] { xyz[i, 0], xyz[i, 1], xyz[i, 2] };
        var quads = Faces.Concat(Sections).Select(q => q.Select(P).ToArray()).ToList();

        double aspect = 1, parallel = 0, corner = 0;
        foreach (var q in quads)
        {
            aspect = Math.Max(aspect, QuadAspect(q));
            parallel = Math.Max(parallel, QuadParallelDeviation(q));
            corner = Math.Max(corner, QuadMaxCornerAngle(q));
        }
        double warping = Faces.Select(f => QuadWarping(f.Select(P).ToArray())).Max();
        return new BrickShape(JacobianRatioOf(xyz), aspect, parallel, corner, warping);
    }

    // ---- Jacobian ratio ---------------------------------------------------------------------------------------

    private static double JacobianRatioOf(double[,] xyz)
    {
        var local = new double[Hex20.Nodes, 3];
        double min = double.MaxValue, max = double.MinValue;
        void Sample(double a, double b, double g)
        {
            Hex20.Derivatives(a, b, g, local);
            var j = new double[3, 3];
            for (int i = 0; i < Hex20.Nodes; i++)
                for (int m = 0; m < 3; m++)
                    for (int n = 0; n < 3; n++) j[m, n] += local[i, n] * xyz[i, m];
            double det = j[0, 0] * (j[1, 1] * j[2, 2] - j[1, 2] * j[2, 1]) - j[0, 1] * (j[1, 0] * j[2, 2] - j[1, 2] * j[2, 0]) + j[0, 2] * (j[1, 0] * j[2, 1] - j[1, 1] * j[2, 0]);
            min = Math.Min(min, det); max = Math.Max(max, det);
        }
        for (int n = 0; n < Hex20.Nodes; n++) Sample(Hex20.Local[n, 0], Hex20.Local[n, 1], Hex20.Local[n, 2]);
        Sample(0, 0, 0);
        if (max > 0 && min > 0) return max / min;
        return -100;                    // opposite signs (or inverted throughout): the documented placeholder for "inverted"
    }

    // ---- quadrilaterals -----------------------------------------------------------------------------------------

    // The aspect ratio: the two bisectors join the midpoints of opposite edges; a rectangle sits on each, as long as
    // its bisector and as wide as the other bisector is across it; the ratio of its sides, of the more stretched one.
    private static double QuadAspect(double[][] p)
    {
        var normal = Normalised(Cross(Sub(p[2], p[0]), Sub(p[3], p[1])));
        double[] Mid(int a, int b) => new[] { (p[a][0] + p[b][0]) / 2, (p[a][1] + p[b][1]) / 2, (p[a][2] + p[b][2]) / 2 };
        double[] Flat(double[] v) { double d = Dot(v, normal); return new[] { v[0] - d * normal[0], v[1] - d * normal[1], v[2] - d * normal[2] }; }
        var a = Flat(Sub(Mid(2, 3), Mid(0, 1)));
        var b = Flat(Sub(Mid(3, 0), Mid(1, 2)));
        return Math.Max(Stretch(a, b), Stretch(b, a));
    }

    // a rectangle along `along` whose width is the part of `other` that lies across it
    private static double Stretch(double[] along, double[] other)
    {
        double length = Norm(along);
        if (length <= 0) return double.PositiveInfinity;
        double d = Dot(other, along) / (length * length);
        double width = Norm(new[] { other[0] - d * along[0], other[1] - d * along[1], other[2] - d * along[2] });
        if (width <= 0) return double.PositiveInfinity;
        return Math.Max(length / width, width / length);
    }

    private static double QuadParallelDeviation(double[][] p)
    {
        double Pair(int a, int b, int c, int d)
        {
            var e1 = Normalised(Sub(p[b], p[a]));
            var e2 = Normalised(Sub(p[c], p[d]));              // the opposite edge, in the same direction
            return Math.Acos(Math.Clamp(Dot(e1, e2), -1, 1)) * 180 / Math.PI;
        }
        return Math.Max(Pair(0, 1, 2, 3), Pair(1, 2, 3, 0));
    }

    private static double QuadMaxCornerAngle(double[][] p)
    {
        double largest = 0;
        for (int i = 0; i < 4; i++)
        {
            var u = Sub(p[(i + 3) % 4], p[i]);
            var v = Sub(p[(i + 1) % 4], p[i]);
            double lu = Norm(u), lv = Norm(v);
            if (lu <= 0 || lv <= 0) continue;
            largest = Math.Max(largest, Math.Acos(Math.Clamp(Dot(u, v) / (lu * lv), -1, 1)) * 180 / Math.PI);
        }
        return largest;
    }

    // The warping factor: the corners lie alternately above and below the mean plane; the height difference along an
    // edge, over the square root of the area projected on that plane.
    private static double QuadWarping(double[][] p)
    {
        var cross = Cross(Sub(p[2], p[0]), Sub(p[3], p[1]));
        double twiceArea = Norm(cross);
        if (twiceArea <= 0) return double.PositiveInfinity;
        var normal = new[] { cross[0] / twiceArea, cross[1] / twiceArea, cross[2] / twiceArea };
        var centre = new[] { (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4, (p[0][2] + p[1][2] + p[2][2] + p[3][2]) / 4 };
        var h = p.Select(q => Dot(Sub(q, centre), normal)).ToArray();
        double difference = 0;
        for (int i = 0; i < 4; i++) difference = Math.Max(difference, Math.Abs(h[i] - h[(i + 1) % 4]));
        return difference / Math.Sqrt(twiceArea / 2);
    }

    private static double[] Sub(double[] a, double[] b) => new[] { a[0] - b[0], a[1] - b[1], a[2] - b[2] };
    private static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    private static double Norm(double[] a) => Math.Sqrt(Dot(a, a));
    private static double[] Cross(double[] a, double[] b) => new[] { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
    private static double[] Normalised(double[] a) { double n = Norm(a); return n > 0 ? new[] { a[0] / n, a[1] / n, a[2] / n } : a; }
}
