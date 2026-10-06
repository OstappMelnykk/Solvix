namespace Solvix.Mesh;

/// <summary>
/// An orthonormal frame attached to a face (from its own 8 node positions): origin
/// at the centre, B1 along the face's u direction, B3 along u x w (w = the face's
/// v direction), B2 completing it. Fitting one face onto another is the rigid
/// motion that carries one frame onto the other.
/// </summary>
internal readonly record struct FaceFrame(Vec3 Origin, Vec3 B1, Vec3 B2, Vec3 B3)
{
    /// <param name="at">Position of the face's slot at face coordinates (u, v) in {-1,0,1}.</param>
    public static FaceFrame? Of(IEnumerable<Vec3> slotPositions, Func<int, int, Vec3> at)
    {
        var centre = Vec3.Zero;
        int count = 0;
        foreach (var p in slotPositions)
        {
            centre += p;
            count++;
        }
        centre *= 1.0 / count;
        var u = at(1, 0) - at(-1, 0);
        var w = at(0, 1) - at(0, -1);
        var normal = Cross(u, w);
        if (u.Length < 1e-12 || normal.Length < 1e-12) return null;
        var b1 = u * (1.0 / u.Length);
        var b3 = normal * (1.0 / normal.Length);
        return new FaceFrame(centre, b1, Cross(b3, b1), b3);
    }

    /// <summary>Carries a point expressed in this frame's world onto the same place in <paramref name="target"/>'s world.</summary>
    public Vec3 CarryTo(FaceFrame target, Vec3 point)
    {
        var d = point - Origin;
        double x = Dot(d, B1), y = Dot(d, B2), z = Dot(d, B3);
        return target.Origin + target.B1 * x + target.B2 * y + target.B3 * z;
    }

    private static Vec3 Cross(Vec3 a, Vec3 b) => new(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X);
    private static double Dot(Vec3 a, Vec3 b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;
}
