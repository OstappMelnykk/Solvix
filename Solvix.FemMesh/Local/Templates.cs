namespace Solvix.FemMesh.Local;

/// <summary>
/// The three transition templates of the three-dimensional algorithm (Owen, Shih, Ernst). The mesh has been rescaled by n beforehand, so every corner
/// of a parent is a multiple of n of the lattice, and every point below - the corner of the parent, or the corner scaled about a base point by
/// k/n, or the point at k/n of an edge - is a lattice point.
/// <list type="bullet">
/// <item><b>T1</b> - one marked corner: n nested copies of the parent scaled about that corner; between neighbouring copies three plates, inside the
/// smallest one a cube: 3(n - 1) + 1 = 3n - 2 children. The three edges at the corner are cut into n parts, the others stay whole.</item>
/// <item><b>T2</b> - one marked edge: the two-dimensional T1 of the cross-section, kept along the edge: 2n - 1 children. The edge itself stays whole.</item>
/// <item><b>T4</b> - one marked face: n slabs parallel to it. The face itself stays whole.</item>
/// </list>
/// Every child is built from its corners and put into its slots by the axes of the lattice (a child's axes are the parent's), so neighbouring cells
/// share their orientation.
/// </summary>
public static class Templates
{
    /// <summary>T1 around the parent's corner (slot k).</summary>
    public static List<Cell> ApplyCorner(HexMesh mesh, Cell parent, int k, int n) => Add(mesh, parent, CornerChildren(mesh.CornersOf(parent), k, n));

    /// <summary>The corners (in slot order) of the children of T1 around the corner k of a parent with corners <paramref name="c"/>.</summary>
    public static List<Pt3[]> CornerChildren(Pt3[] c, int k, int n)
    {
        // the frame corner (a, b, c) is the parent's corner k with the bits a, b, c of the axes flipped; scaled about corner k by s / n
        Pt3 Scaled(int a, int b, int cc, int s) => Along(c[k], c[k ^ (a | b << 1 | cc << 2)], s, n);
        var children = new List<Pt3[]>(3 * n - 2);
        void Add(Func<int, int, int, Pt3> corner)
        {
            var corners = new Pt3[8];
            for (int a = 0; a < 2; a++) for (int b = 0; b < 2; b++) for (int cc = 0; cc < 2; cc++)
                corners[(a ^ Hex.Bit(k, 0)) | (b ^ Hex.Bit(k, 1)) << 1 | (cc ^ Hex.Bit(k, 2)) << 2] = corner(a, b, cc);
            children.Add(corners);
        }
        for (int m = n; m >= 2; m--)
        {
            Add((a, b, cc) => Scaled(1, b, cc, a == 1 ? m : m - 1));        // the plate with its outer face at x = m
            Add((a, b, cc) => Scaled(a, 1, cc, b == 1 ? m : m - 1));        // y = m
            Add((a, b, cc) => Scaled(a, b, 1, cc == 1 ? m : m - 1));        // z = m
        }
        Add((a, b, cc) => Scaled(a, b, cc, 1));                              // the corner cube
        return children;
    }

    /// <summary>T2 along the parent's edge that runs along <paramref name="axis"/> and starts at slot <paramref name="start"/> (its end on the minus side).</summary>
    public static List<Cell> ApplyEdge(HexMesh mesh, Cell parent, int axis, int start, int n) => Add(mesh, parent, EdgeChildren(mesh.CornersOf(parent), axis, start, n));

    public static List<Pt3[]> EdgeChildren(Pt3[] c, int axis, int start, int n)
    {
        var (u, v) = Hex.Others(axis);
        int pu = Hex.Bit(start, u), pv = Hex.Bit(start, v);
        // the cross-section corner (su, sv) at the end e of the edge, scaled about the marked edge's end by s / n
        Pt3 Scaled(int su, int sv, int e, int s)
        {
            int baseSlot = e << axis | pu << u | pv << v;
            int slot = e << axis | (pu ^ su) << u | (pv ^ sv) << v;
            return Along(c[baseSlot], c[slot], s, n);
        }
        var children = new List<Pt3[]>(2 * n - 1);
        void Add(Func<int, int, int, Pt3> corner)                              // corner(au, av, ae) with the child's own axes along the cross-section's
        {
            var corners = new Pt3[8];
            for (int au = 0; au < 2; au++) for (int av = 0; av < 2; av++) for (int ae = 0; ae < 2; ae++)
                corners[(au ^ pu) << u | (av ^ pv) << v | ae << axis] = corner(au, av, ae);
            children.Add(corners);
        }
        for (int m = n; m >= 2; m--)
        {
            Add((au, av, ae) => Scaled(1, av, ae, au == 1 ? m : m - 1));
            Add((au, av, ae) => Scaled(au, 1, ae, av == 1 ? m : m - 1));
        }
        Add((au, av, ae) => Scaled(au, av, ae, 1));
        return children;
    }

    /// <summary>T4: n slabs parallel to the parent's face on the given side of the given axis.</summary>
    public static List<Cell> ApplyFace(HexMesh mesh, Cell parent, int axis, int side, int n) => Add(mesh, parent, FaceChildren(mesh.CornersOf(parent), axis, side, n));

    public static List<Pt3[]> FaceChildren(Pt3[] c, int axis, int side, int n)
    {
        var (u, v) = Hex.Others(axis);
        // layer j: the face moved towards the opposite face by j / n
        Pt3 Layer(int su, int sv, int j) => Along(c[side << axis | su << u | sv << v], c[(1 - side) << axis | su << u | sv << v], j, n);
        var children = new List<Pt3[]>(n);
        for (int i = 0; i < n; i++)
        {
            var corners = new Pt3[8];
            for (int au = 0; au < 2; au++) for (int av = 0; av < 2; av++) for (int af = 0; af < 2; af++)
                corners[(af ^ side) << axis | au << u | av << v] = Layer(au, av, i + af);
            children.Add(corners);
        }
        return children;
    }

    /// <summary>The children of the template for a pattern (the corners of each, in slot order), without touching any mesh; null for a pattern without a template.</summary>
    public static List<Pt3[]>? ChildrenFor(Pt3[] parent, int mask, int n)
    {
        switch (Patterns.KindOf(mask))
        {
            case Patterns.Kind.Corner: return CornerChildren(parent, Patterns.SlotsOf(mask)[0], n);
            case Patterns.Kind.Edge: { var (axis, start) = Patterns.EdgeOf(mask); return EdgeChildren(parent, axis, start, n); }
            case Patterns.Kind.Face: { var (axis, side) = Patterns.FaceOf(mask); return FaceChildren(parent, axis, side, n); }
            default: return null;
        }
    }

    /// <summary>Does the template give valid children: every child with a positive Jacobian at all its corners?</summary>
    public static bool IsValid(List<Pt3[]> children) => children.All(ch => Enumerable.Range(0, 8).All(s => Conformity.JacobianAtCorner(ch, s) > 0));

    private static List<Cell> Add(HexMesh mesh, Cell parent, List<Pt3[]> children) => children.Select(corners => mesh.AddCell(parent.Root, corners)).ToList();

    // a + (b - a) * numerator / n, exact because the lattice has been scaled by n
    private static Pt3 Along(Pt3 a, Pt3 b, int numerator, int n)
    {
        var d = b - a;
        if (d.X % n != 0 || d.Y % n != 0 || d.Z % n != 0) throw new InvalidOperationException("The lattice was not scaled by n before the template.");
        return new Pt3(a.X + d.X / n * numerator, a.Y + d.Y / n * numerator, a.Z + d.Z / n * numerator);
    }
}
