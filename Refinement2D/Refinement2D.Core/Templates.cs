namespace Refinement2D.Core;

/// <summary>
/// The two transition templates of the two-dimensional algorithm (Owen, Shih, Ernst). A cell has marked nodes; their pattern picks the
/// template:
/// <list type="bullet">
/// <item><b>T1</b> - one marked corner: n nested copies of the cell scaled about that corner, which gives 2n - 1 children
/// (the corner square, and two trapezoids in every ring). The two edges at the corner are cut into n parts; the other two stay whole.</item>
/// <item><b>T2</b> - two marked nodes on one edge: n strips parallel to that edge, n children. The edge itself stays whole; the two edges
/// across it are cut into n parts.</item>
/// </list>
/// All new nodes lie at k/n of an edge of the parent; the mesh has been rescaled by n beforehand, so they are lattice points.
/// </summary>
public static class Templates
{
    /// <summary>T2: the parent split into n strips parallel to its edge (slot, slot + 1).</summary>
    public static List<Cell> ApplyEdge(QuadMesh mesh, Cell parent, int edge, int n)
    {
        Pt P(int slot) => mesh.PointOf(parent.Nodes[((slot % 4) + 4) % 4]);
        // the marked edge (e, e + 1) and the edge opposite to it, joined by the sides (e, e + 3) and (e + 1, e + 2)
        Pt A(int i) => Lerp(P(edge), P(edge + 3), i, n);
        Pt B(int i) => Lerp(P(edge + 1), P(edge + 2), i, n);
        var children = new List<Cell>(n);
        for (int i = 0; i < n; i++) children.Add(mesh.AddCell(parent.Root, A(i), B(i), B(i + 1), A(i + 1)));
        return children;
    }

    /// <summary>T1: the parent split into 2n - 1 children around its corner (slot).</summary>
    public static List<Cell> ApplyCorner(QuadMesh mesh, Cell parent, int corner, int n)
    {
        Pt P(int slot) => mesh.PointOf(parent.Nodes[((slot % 4) + 4) % 4]);
        var c = P(corner);
        // the level i square, scaled about the corner by (n - i) / n: its corner, the points on the two edges at the corner, and the far one
        Pt Along(Pt end, int i) => Lerp(c, end, n - i, n);
        Pt Side1(int i) => Along(P(corner + 1), i);
        Pt Side2(int i) => Along(P(corner + 3), i);
        Pt Far(int i) => Along(P(corner + 2), i);
        var children = new List<Cell>(2 * n - 1);
        for (int i = 0; i < n - 1; i++)
        {
            // between the level i (outer) and the level i + 1 (inner): the trapezoid along the first edge, and along the second
            children.Add(mesh.AddCell(parent.Root, Side1(i + 1), Side1(i), Far(i), Far(i + 1)));
            children.Add(mesh.AddCell(parent.Root, Side2(i + 1), Far(i + 1), Far(i), Side2(i)));
        }
        // the innermost: the corner square (the level n - 1)
        children.Add(mesh.AddCell(parent.Root, c, Side1(n - 1), Far(n - 1), Side2(n - 1)));
        return children;
    }

    // a + (b - a) * numerator / n, exact because the lattice has been scaled by n
    private static Pt Lerp(Pt a, Pt b, int numerator, int n)
    {
        long dx = b.X - a.X, dy = b.Y - a.Y;
        if (dx % n != 0 || dy % n != 0) throw new InvalidOperationException("The lattice was not scaled by n before the template.");
        return new Pt(a.X + dx / n * numerator, a.Y + dy / n * numerator);
    }
}
