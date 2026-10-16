namespace Solvix.FemMesh.Local;

/// <summary>
/// The checks a refined mesh has to pass. An empty list means: every cell is a valid hexahedron in the lattice axes (positive Jacobian at all eight
/// corners), every face belongs to at most two cells that meet it from opposite sides of the same axis, no face is left open inside the grid (a
/// face with one owner lies on the boundary of the coarse grid, where there is no coarse cell on the other side - so no node hangs on a coarser
/// face and there are no gaps), and the leaves of each coarse cell fill exactly its volume (no overlaps).
/// </summary>
public static class Conformity
{
    public static List<string> Check(HexMesh mesh)
    {
        var problems = new List<string>();
        var faces = new Dictionary<(int, int, int, int), List<(int Cell, int Axis, int Side)>>();

        foreach (var cell in mesh.Cells.Values)
        {
            var p = mesh.CornersOf(cell);
            if (cell.Nodes.Distinct().Count() != 8) problems.Add($"cell {cell.Id} has repeated nodes");
            for (int s = 0; s < 8; s++)
                if (JacobianAtCorner(p, s) <= 0) problems.Add($"cell {cell.Id} is inverted or degenerate at slot {s}");
            for (int axis = 0; axis < 3; axis++)
                for (int side = 0; side < 2; side++)
                {
                    var key = FaceKey(cell, axis, side);
                    if (!faces.TryGetValue(key, out var owners)) faces[key] = owners = new();
                    owners.Add((cell.Id, axis, side));
                }
        }

        var roots = mesh.Roots.ToDictionary(r => (r.I, r.J, r.K));
        foreach (var (key, owners) in faces)
        {
            if (owners.Count > 2) { problems.Add($"face {key} belongs to {owners.Count} cells"); continue; }
            if (owners.Count == 2)
            {
                continue;                                                     // two owners: the Jacobians and the volumes below say they are on opposite sides
            }
            // one owner: it must lie on the outside of the coarse grid
            var owner = owners[0];
            if (!OnOuterBoundary(mesh, roots, mesh.Cells[owner.Cell], owner.Axis, owner.Side))
                problems.Add($"face {key} of cell {owner.Cell} is open inside the grid (a gap, or a node hangs on it)");
        }

        // the leaves of a coarse cell fill it exactly
        double unit = (double)mesh.Scale * mesh.Scale * mesh.Scale;
        foreach (var root in mesh.Roots)
        {
            double volume = root.Leaves.Sum(id => Volume(mesh.CornersOf(mesh.Cells[id]))) / unit;
            if (Math.Abs(volume - 1.0) > 1e-9) problems.Add($"root ({root.I},{root.J},{root.K}): the leaves fill {volume:0.########} of it");
        }
        return problems;
    }

    /// <summary>
    /// The shared faces that the two cells meet along different axes of their own (the diagonal faces between the plates of T1 and T2 are such). A mesh
    /// can be conforming and still have them; a consumer that pairs a face of one cell with the same-axis face of its neighbour has to know.
    /// </summary>
    public static int AxisMismatchedFaces(HexMesh mesh)
    {
        var faces = new Dictionary<(int, int, int, int), List<int>>();
        foreach (var cell in mesh.Cells.Values)
            for (int axis = 0; axis < 3; axis++)
                for (int side = 0; side < 2; side++)
                {
                    var key = FaceKey(cell, axis, side);
                    if (!faces.TryGetValue(key, out var owners)) faces[key] = owners = new();
                    owners.Add(axis * 2 + side);
                }
        return faces.Values.Count(o => o.Count == 2 && (o[0] / 2 != o[1] / 2 || o[0] % 2 == o[1] % 2));
    }

    public static (int, int, int, int) FaceKey(Cell cell, int axis, int side)
    {
        var n = Hex.FaceSlots(axis, side).Select(s => cell.Nodes[s]).OrderBy(x => x).ToArray();
        return (n[0], n[1], n[2], n[3]);
    }

    // a face with one owner is on the outside when it lies in a plane of the coarse lattice and the coarse cell on the other side of that plane is missing
    private static bool OnOuterBoundary(HexMesh mesh, Dictionary<(int, int, int), Root> roots, Cell cell, int axis, int side)
    {
        var corners = Hex.FaceSlots(axis, side).Select(s => mesh.PointOf(cell.Nodes[s])).ToArray();
        long at = corners[0][axis];
        if (corners.Any(c => c[axis] != at) || at % mesh.Scale != 0) return false;
        var root = mesh.Roots[cell.Root];
        int step = side == 1 ? 1 : -1;
        var next = (root.I + (axis == 0 ? step : 0), root.J + (axis == 1 ? step : 0), root.K + (axis == 2 ? step : 0));
        // the face must be a face of the coarse cell itself, not a plane inside it
        long plane = (root.Layer(axis) + (side == 1 ? 1 : 0)) * mesh.Scale;
        return at == plane && !roots.ContainsKey(next);
    }

    // the determinant of the three edge vectors leaving a corner towards the other corners along +x, +y, +z of the cell
    public static Int128 JacobianAtCorner(Pt3[] p, int slot)
    {
        Pt3 Toward(int axis) => Hex.Bit(slot, axis) == 0 ? p[slot ^ (1 << axis)] - p[slot] : p[slot] - p[slot ^ (1 << axis)];
        var (a, b, c) = (Toward(0), Toward(1), Toward(2));
        // 128 bits: the coordinates are kept below 2^40 (see Refiner.EnsureFine), so the product of three differences cannot overflow
        Int128 ax = a.X, ay = a.Y, az = a.Z, bx = b.X, by = b.Y, bz = b.Z, cx = c.X, cy = c.Y, cz = c.Z;
        return ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }

    /// <summary>The volume of the trilinear hexahedron, exact by the two-point Gauss rule (the Jacobian is of degree two in each variable).</summary>
    public static double Volume(Pt3[] p)
    {
        double g = 0.5 / Math.Sqrt(3.0);
        double total = 0;
        foreach (int ix in new[] { 0, 1 }) foreach (int iy in new[] { 0, 1 }) foreach (int iz in new[] { 0, 1 })
        {
            double u = 0.5 + (ix == 0 ? -g : g), v = 0.5 + (iy == 0 ? -g : g), w = 0.5 + (iz == 0 ? -g : g);
            // partial derivatives of the trilinear map
            double[] du = new double[3], dv = new double[3], dw = new double[3];
            for (int s = 0; s < 8; s++)
            {
                int a = Hex.Bit(s, 0), b = Hex.Bit(s, 1), c = Hex.Bit(s, 2);
                double fu = a == 1 ? u : 1 - u, fv = b == 1 ? v : 1 - v, fw = c == 1 ? w : 1 - w;
                double gu = a == 1 ? 1 : -1, gv = b == 1 ? 1 : -1, gw = c == 1 ? 1 : -1;
                for (int k = 0; k < 3; k++)
                {
                    du[k] += gu * fv * fw * p[s][k];
                    dv[k] += fu * gv * fw * p[s][k];
                    dw[k] += fu * fv * gw * p[s][k];
                }
            }
            total += du[0] * (dv[1] * dw[2] - dv[2] * dw[1]) - du[1] * (dv[0] * dw[2] - dv[2] * dw[0]) + du[2] * (dv[0] * dw[1] - dv[1] * dw[0]);
        }
        return total / 8.0;
    }
}
