using Solvix.Contracts.Facades;

namespace Solvix.FemMesh.Local;

/// <summary>
/// Turns the leaves of a refined lattice into a mesh of 20-node elements. The corners of a leaf are lattice points; an edge midpoint is the middle of its two
/// corners; the real position of any of them is its place in its cube pushed through the cube's own 20-node map. Two cubes share a node only where they are
/// linked (they share a face in the editor): cubes that merely stand side by side get nodes of their own, as in the editor.
/// </summary>
internal static class LatticeToFem
{
    // For each of the 20 nodes of the solver's element: the two core slots whose lattice points it is the middle of (the same one twice for a corner).
    private static readonly (int A, int B)[] Ends = BuildEnds();

    private static (int A, int B)[] BuildEnds()
    {
        int SlotOf(int sx, int sy, int sz) => (sx > 0 ? 1 : 0) | (sy > 0 ? 2 : 0) | (sz > 0 ? 4 : 0);
        var ends = new (int, int)[20];
        for (int k = 0; k < 20; k++)
        {
            int x = ElementLocal.Nodes[k, 0], y = ElementLocal.Nodes[k, 1], z = ElementLocal.Nodes[k, 2];
            ends[k] = (SlotOf(x, y, z), SlotOf(x, y, z));
            if (x == 0) ends[k] = (SlotOf(-1, y, z), SlotOf(1, y, z));
            else if (y == 0) ends[k] = (SlotOf(x, -1, z), SlotOf(x, 1, z));
            else if (z == 0) ends[k] = (SlotOf(x, y, -1), SlotOf(x, y, 1));
        }
        return ends;
    }

    public static IFemMesh Convert(LatticeMesh lattice, FemMeshDto coarse)
    {
        var cells = lattice.Cells.Values.OrderBy(c => c.Root).ThenBy(c => c.Id).ToList();
        int count = cells.Count;
        long scale = lattice.Scale;

        // ---- the 20 places of every element, on the doubled lattice (so that the middle of two points is a whole number) ----
        var place = new (long X, long Y, long Z)[count, 20];
        for (int e = 0; e < count; e++)
        {
            var corner = cells[e].Nodes.Select(lattice.PointOf).ToArray();
            for (int k = 0; k < 20; k++)
            {
                var (a, b) = Ends[k];
                place[e, k] = (corner[a].X + corner[b].X, corner[a].Y + corner[b].Y, corner[a].Z + corner[b].Z);
            }
        }

        // ---- which nodes are one: the same place in the same cube, and the same place on a face that two linked cubes share ----
        var occurrence = new Dictionary<(int Root, long X, long Y, long Z), int>();
        var rootsAt = new Dictionary<(long, long, long), List<int>>();
        int occurrences = 0;
        var occurrenceOf = new int[count, 20];
        for (int e = 0; e < count; e++)
            for (int k = 0; k < 20; k++)
            {
                var (x, y, z) = place[e, k];
                var key = (cells[e].Root, x, y, z);
                if (!occurrence.TryGetValue(key, out int id))
                {
                    id = occurrence[key] = occurrences++;
                    if (!rootsAt.TryGetValue((x, y, z), out var roots)) rootsAt[(x, y, z)] = roots = new();
                    roots.Add(cells[e].Root);
                }
                occurrenceOf[e, k] = id;
            }
        var parent = Enumerable.Range(0, occurrences).ToArray();
        int Find(int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; }
        var linked = LinkedCubes(coarse);
        foreach (var ((x, y, z), roots) in rootsAt)
            for (int i = 0; i < roots.Count; i++)
                for (int j = i + 1; j < roots.Count; j++)
                    if (linked.Contains((roots[i], roots[j])))
                        parent[Find(occurrence[(roots[i], x, y, z)])] = Find(occurrence[(roots[j], x, y, z)]);

        // ---- the nodes and their positions ----
        var nodeOfComponent = new Dictionary<int, int>();
        var positions = new List<double[]>();
        var connectivity = new int[count, 20];
        var rootCorners = new Dictionary<int, double[][]>();
        for (int e = 0; e < count; e++)
        {
            int cube = cells[e].Root;
            for (int k = 0; k < 20; k++)
            {
                int component = Find(occurrenceOf[e, k]);
                if (!nodeOfComponent.TryGetValue(component, out int node))
                {
                    node = nodeOfComponent[component] = positions.Count;
                    positions.Add(Push(coarse, rootCorners, lattice, cube, Local(lattice, cube, place[e, k], scale)));
                }
                connectivity[e, k] = node;
            }
        }

        // ---- where each element and face lies in its cube, and which faces lie on a side of the cube ----
        var roots2 = new int[count];
        var keys = new string[count];
        var centres = new ParametricPoint[count];
        var faceCentres = new ParametricPoint[count, 6];
        var cornerPoints = new ParametricPoint[count][];
        var sides = new string?[count, 6];
        for (int e = 0; e < count; e++)
        {
            var cell = cells[e];
            var root = lattice.Roots[cell.Root];
            roots2[e] = cell.Root;
            keys[e] = LocalRefinement.LeafKey(lattice, cell);
            var corner = cell.Nodes.Select(lattice.PointOf).ToArray();
            ParametricPoint At(Pt3 p) => new(2 * (p.X / (double)scale - root.I) - 1, 2 * (p.Y / (double)scale - root.J) - 1, 2 * (p.Z / (double)scale - root.K) - 1);
            ParametricPoint Middle(IEnumerable<int> slots)
            {
                var list = slots.ToList();
                double x = list.Average(s => (double)corner[s].X), y = list.Average(s => (double)corner[s].Y), z = list.Average(s => (double)corner[s].Z);
                return new ParametricPoint(2 * (x / scale - root.I) - 1, 2 * (y / scale - root.J) - 1, 2 * (z / scale - root.K) - 1);
            }
            centres[e] = Middle(Enumerable.Range(0, 8));
            // the corners in the order of the solver's first 8 nodes (each is the lattice slot with the same signs)
            cornerPoints[e] = Enumerable.Range(0, 8).Select(k => At(corner[(ElementLocal.Nodes[k, 0] > 0 ? 1 : 0) | (ElementLocal.Nodes[k, 1] > 0 ? 2 : 0) | (ElementLocal.Nodes[k, 2] > 0 ? 4 : 0)])).ToArray();
            for (int f = 0; f < 6; f++)
            {
                var (axis, sign) = ElementLocal.FaceAxis(f);
                var slots = Enumerable.Range(0, 8).Where(s => Hex.Bit(s, axis) == (sign > 0 ? 1 : 0)).ToList();
                faceCentres[e, f] = Middle(slots);
                long end = ((axis == 0 ? root.I : axis == 1 ? root.J : root.K) + (sign > 0 ? 1 : 0)) * scale;
                if (slots.All(s => corner[s][axis] == end)) sides[e, f] = ElementLocal.FaceNames[f];
            }
        }

        var flat = new double[positions.Count, 3];
        for (int n = 0; n < positions.Count; n++)
            for (int c = 0; c < 3; c++) flat[n, c] = positions[n][c];
        return new FemMesh(flat, connectivity, roots2, keys, centres, faceCentres, cornerPoints, sides);
    }

    // The place of a point of the doubled lattice in its cube, in the cube's own coordinates [-1, 1].
    private static (double A, double B, double G) Local(LatticeMesh lattice, int cube, (long X, long Y, long Z) doubled, long scale)
    {
        var root = lattice.Roots[cube];
        return (doubled.X / (double)scale - 2 * root.I - 1, doubled.Y / (double)scale - 2 * root.J - 1, doubled.Z / (double)scale - 2 * root.K - 1);
    }

    private static double[] Push(FemMeshDto coarse, Dictionary<int, double[][]> cache, LatticeMesh lattice, int cube, (double A, double B, double G) at)
    {
        if (!cache.TryGetValue(cube, out var corners))
        {
            corners = new double[20][];
            for (int s = 0; s < 20; s++)
            {
                int node = coarse.Connectivity[cube * 20 + s];
                corners[s] = new[] { coarse.Positions[node * 3], coarse.Positions[node * 3 + 1], coarse.Positions[node * 3 + 2] };
            }
            cache[cube] = corners;
        }
        var phi = ElementLocal.ShapeFunctions(at.A, at.B, at.G);
        var position = new double[3];
        for (int s = 0; s < 20; s++)
            for (int c = 0; c < 3; c++) position[c] += phi[s] * corners[s][c];
        return position;
    }

    // Pairs of cubes (both ways round) that share a whole face: the same eight nodes.
    private static HashSet<(int, int)> LinkedCubes(FemMeshDto coarse)
    {
        var byFace = new Dictionary<string, List<int>>();
        for (int e = 0; e < coarse.ElementCount; e++)
            for (int f = 0; f < 6; f++)
            {
                string key = string.Join(',', ElementLocal.FaceNodes[f].Select(s => coarse.Connectivity[e * 20 + s]).OrderBy(i => i));
                if (!byFace.TryGetValue(key, out var list)) byFace[key] = list = new();
                list.Add(e);
            }
        var pairs = new HashSet<(int, int)>();
        foreach (var list in byFace.Values)
            foreach (int a in list)
                foreach (int b in list)
                    if (a != b) pairs.Add((a, b));
        return pairs;
    }
}
