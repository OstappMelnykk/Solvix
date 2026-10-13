namespace Refinement2D.Core;

/// <summary>
/// The checks a refined mesh has to pass. An empty list means: every cell is a convex quadrilateral in the canonical order, no node lies
/// on the inside of a cell's edge (no hanging node), every edge belongs to at most two cells, and the cells of each coarse cell tile it.
/// </summary>
public static class Conformity
{
    public static List<string> Check(QuadMesh mesh)
    {
        var problems = new List<string>();
        var edges = new Dictionary<(int, int), List<int>>();

        foreach (var cell in mesh.Cells.Values)
        {
            var p = cell.Nodes.Select(mesh.PointOf).ToArray();
            if (cell.Nodes.Distinct().Count() != 4) problems.Add($"cell {cell.Id} has repeated nodes");
            for (int k = 0; k < 4; k++)
            {
                // convex and counter-clockwise: every turn is to the left
                var a = p[k]; var b = p[(k + 1) % 4]; var c = p[(k + 2) % 4];
                if (Cross(a, b, c) <= 0) problems.Add($"cell {cell.Id} is not convex or not counter-clockwise at slot {(k + 1) % 4}");
                int u = cell.Nodes[k], v = cell.Nodes[(k + 1) % 4];
                var key = u < v ? (u, v) : (v, u);
                if (!edges.TryGetValue(key, out var owners)) edges[key] = owners = new List<int>();
                owners.Add(cell.Id);
            }
            // the canonical axes: slot 0 -> 1 points along +x, slot 0 -> 3 along +y
            if (p[1].X - p[0].X <= 0 && p[2].X - p[3].X <= 0) problems.Add($"cell {cell.Id}: slot 0 -> 1 does not point along +x");
            if (p[3].Y - p[0].Y <= 0 && p[2].Y - p[1].Y <= 0) problems.Add($"cell {cell.Id}: slot 0 -> 3 does not point along +y");
        }

        foreach (var (edge, owners) in edges)
            if (owners.Count > 2) problems.Add($"edge {edge} belongs to {owners.Count} cells");

        // no hanging nodes: a node strictly between the ends of an edge
        foreach (var ((u, v), _) in edges)
        {
            var a = mesh.PointOf(u); var b = mesh.PointOf(v);
            long minX = Math.Min(a.X, b.X), maxX = Math.Max(a.X, b.X), minY = Math.Min(a.Y, b.Y), maxY = Math.Max(a.Y, b.Y);
            for (int id = 0; id < mesh.Nodes.Count; id++)
            {
                if (id == u || id == v) continue;
                var q = mesh.Nodes[id];
                if (q.X < minX || q.X > maxX || q.Y < minY || q.Y > maxY) continue;
                if (Cross(a, b, q) == 0) problems.Add($"node {id} {q} hangs on the edge {u}-{v}");
            }
        }

        // the leaves of each coarse cell fill it exactly, and nothing sticks out of it
        long d = mesh.Scale;
        foreach (var root in mesh.Roots)
        {
            long area2 = 0;
            foreach (int leaf in root.Leaves)
            {
                var cell = mesh.Cells[leaf];
                var p = cell.Nodes.Select(mesh.PointOf).ToArray();
                for (int k = 0; k < 4; k++) area2 += p[k].X * p[(k + 1) % 4].Y - p[(k + 1) % 4].X * p[k].Y;
                foreach (var q in p)
                    if (q.X < root.I * d || q.X > (root.I + 1) * d || q.Y < root.J * d || q.Y > (root.J + 1) * d)
                        problems.Add($"cell {leaf} sticks out of its coarse cell ({root.I}, {root.J})");
            }
            if (area2 != 2 * d * d) problems.Add($"the cells of the coarse cell ({root.I}, {root.J}) cover {area2 / 2.0} instead of {d * d}");
        }
        return problems;
    }

    private static long Cross(Pt a, Pt b, Pt c) => (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
}
