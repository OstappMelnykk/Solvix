namespace Solvix.Mesh;

public readonly record struct Vec3(double X, double Y, double Z)
{
    public static Vec3 Zero => new(0, 0, 0);

    public static Vec3 operator +(Vec3 a, Vec3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
    public static Vec3 operator -(Vec3 a, Vec3 b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
    public static Vec3 operator *(Vec3 a, double s) => new(a.X * s, a.Y * s, a.Z * s);
    public static Vec3 operator *(double s, Vec3 a) => a * s;

    public double this[int axis] => axis switch { 0 => X, 1 => Y, 2 => Z, _ => throw new ArgumentOutOfRangeException(nameof(axis)) };

    public double Length => Math.Sqrt(X * X + Y * Y + Z * Z);

    public Vec3 With(int axis, double value) => axis switch
    {
        0 => this with { X = value },
        1 => this with { Y = value },
        2 => this with { Z = value },
        _ => throw new ArgumentOutOfRangeException(nameof(axis))
    };
}
