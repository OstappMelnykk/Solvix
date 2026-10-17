namespace Solvix.Mesh;

/// <summary>The outer skin of a body as triangles, and how far the flat triangles stray from the curved surface they sample.</summary>
/// <param name="Faces">How many cube faces make up the skin.</param>
/// <param name="MaxDeviation">The largest distance between a triangle and the true surface, in model units (an estimate from sample points).</param>
public sealed record ShellMesh(IReadOnlyList<(Vec3 A, Vec3 B, Vec3 C)> Triangles, int Faces, double MaxDeviation);

/// <summary>
/// Turns the cubes of the editor into a closed triangle skin. Every face that has nothing on the other side is a curved patch (8 nodes, parabolic
/// edges); it is sampled on a (n + 1) x (n + 1) grid by the same shape functions the editor and the solver use, so every vertex lies exactly on
/// the real surface, and each grid square is cut into two triangles. Two faces that meet share their edge's three nodes, so they sample the
/// same points along it and the skin has no cracks. The cubes themselves, and any inner face, are left out.
/// </summary>
public static class ShellExport
{
    public const int MaxDensity = 64;

    public static ShellMesh Build(HexMesh mesh, int density)
    {
        if (density < 1 || density > MaxDensity) throw new ArgumentOutOfRangeException(nameof(density), $"Density must be 1..{MaxDensity}.");
        var triangles = new List<(Vec3, Vec3, Vec3)>();
        double deviation = 0;
        int faces = 0;
        foreach (var hex in mesh.Hexes.OrderBy(h => h.Id))
        {
            var positions = hex.Positions();
            foreach (var face in HexFaces.All)
            {
                if (!IsOuter(mesh, hex, face)) continue;
                faces++;
                deviation = Math.Max(deviation, AddFace(positions, face, density, triangles));
            }
        }
        return new ShellMesh(triangles, faces, deviation);
    }

    /// <summary>A face is outer when no cube is linked to it, and none stands on the other side of it with the same nodes in the same places.</summary>
    public static bool IsOuter(HexMesh mesh, Hex20 hex, HexFace face)
    {
        if (mesh.Neighbor(hex.Id, face) is not null) return false;
        var across = hex.Cell;
        var (di, dj, dk) = face.Offset();
        var other = mesh.HexAtCell((across.I + di, across.J + dj, across.K + dk));
        if (other is null) return true;
        foreach (int slot in face.Slots())
        {
            int partner = face.PartnerSlot(slot);
            var a = mesh.Node(hex.NodeIds[slot]).Position;
            var b = mesh.Node(other.NodeIds[partner]).Position;
            if ((a - b).Length > 1e-6) return true;                     // they only stand side by side, with a gap or an overlap
        }
        return false;
    }

    private static double AddFace(IReadOnlyList<Vec3> positions, HexFace face, int n, List<(Vec3, Vec3, Vec3)> triangles)
    {
        int axis = face.Axis(), s = face.Sign();
        int u = (axis + 1) % 3, v = (axis + 2) % 3;
        Vec3 Xi(double a, double b) => new Vec3(0, 0, 0).With(axis, s).With(u, a).With(v, b);
        Vec3 At(double a, double b) => Hex20Geometry.Map(positions, Xi(a, b));
        double Param(int i) => -1.0 + 2.0 * i / n;

        var grid = new Vec3[n + 1, n + 1];
        for (int i = 0; i <= n; i++)
            for (int j = 0; j <= n; j++) grid[i, j] = At(Param(i), Param(j));

        // outward = the way the cube grows off this face; the grid's own normal is flipped to agree with it
        var jac = Hex20Geometry.Jacobian(positions, Xi(0, 0));
        var outward = new Vec3(jac[0, axis], jac[1, axis], jac[2, axis]) * s;
        bool flip = Dot(Cross(grid[1, 0] - grid[0, 0], grid[0, 1] - grid[0, 0]), outward) < 0;

        double deviation = 0;
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++)
            {
                var p00 = grid[i, j]; var p10 = grid[i + 1, j]; var p11 = grid[i + 1, j + 1]; var p01 = grid[i, j + 1];
                double a0 = Param(i), a1 = Param(i + 1), b0 = Param(j), b1 = Param(j + 1);
                AddTriangle(triangles, p00, p10, p11, flip);
                AddTriangle(triangles, p00, p11, p01, flip);
                deviation = Math.Max(deviation, Strays(At, (a0, b0, p00), (a1, b0, p10), (a1, b1, p11)));
                deviation = Math.Max(deviation, Strays(At, (a0, b0, p00), (a1, b1, p11), (a0, b1, p01)));
            }
        return deviation;
    }

    private static void AddTriangle(List<(Vec3, Vec3, Vec3)> triangles, Vec3 a, Vec3 b, Vec3 c, bool flip) =>
        triangles.Add(flip ? (a, c, b) : (a, b, c));

    /// <summary>How far the true surface lies from the triangle at its centre (from its plane) and at the middle of each side (from the side).</summary>
    private static double Strays(Func<double, double, Vec3> at, (double A, double B, Vec3 P) p, (double A, double B, Vec3 P) q, (double A, double B, Vec3 P) r)
    {
        double worst = 0;
        var normal = Cross(q.P - p.P, r.P - p.P);
        double length = normal.Length;
        if (length > 0)
        {
            var centre = at((p.A + q.A + r.A) / 3, (p.B + q.B + r.B) / 3);
            worst = Math.Abs(Dot(centre - p.P, normal)) / length;
        }
        foreach (var (x, y) in new[] { (p, q), (q, r), (r, p) })
        {
            var middle = at((x.A + y.A) / 2, (x.B + y.B) / 2);
            worst = Math.Max(worst, (middle - (x.P + y.P) * 0.5).Length);
        }
        return worst;
    }

    private static double Dot(Vec3 a, Vec3 b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

    private static Vec3 Cross(Vec3 a, Vec3 b) => new(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X);

    /// <summary>Binary STL (80-byte header, then a count and 50 bytes a triangle); the normals are the triangles' own.</summary>
    public static byte[] ToBinaryStl(ShellMesh shell, string header = "Solvix shell")
    {
        using var stream = new MemoryStream(84 + 50 * shell.Triangles.Count);
        using var writer = new BinaryWriter(stream);
        var head = new byte[80];
        System.Text.Encoding.ASCII.GetBytes(header, 0, Math.Min(header.Length, 80), head, 0);
        writer.Write(head);
        writer.Write((uint)shell.Triangles.Count);
        foreach (var (a, b, c) in shell.Triangles)
        {
            var normal = Cross(b - a, c - a);
            double length = normal.Length;
            if (length > 0) normal = normal * (1.0 / length);
            Write(writer, normal); Write(writer, a); Write(writer, b); Write(writer, c);
            writer.Write((ushort)0);
        }
        writer.Flush();
        return stream.ToArray();
    }

    private static void Write(BinaryWriter writer, Vec3 p)
    {
        writer.Write((float)p.X); writer.Write((float)p.Y); writer.Write((float)p.Z);
    }
}
