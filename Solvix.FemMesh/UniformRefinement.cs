using Solvix.Contracts.Facades;

namespace Solvix.FemMesh;

/// <summary>
/// The even rule: every cube of the editor is cut into nx*ny*nz equal small elements (in the cube's own coordinates). The nodes of a small element
/// sit at the shape-function image of their place in the cube; nodes on a face shared by two cubes are one node, so the body stays one connected mesh.
/// </summary>
public sealed class UniformRefinement(int nx, int ny, int nz) : IMeshRefinement
{
    public string Name => $"uniform {nx}x{ny}x{nz}";

    public int Nx { get; } = nx;
    public int Ny { get; } = ny;
    public int Nz { get; } = nz;

    public IFemMesh Build(FemMeshDto coarse)
    {
        int cubes = coarse.ElementCount;
        var points = GridPoints(Nx, Ny, Nz);
        int g = points.Length;
        var gridIndex = new Dictionary<(int, int, int), int>();
        for (int i = 0; i < g; i++) gridIndex[points[i]] = i;

        // ---- which nodes are one: unite the grid points on every face that two cubes share --------------
        var parent = Enumerable.Range(0, cubes * g).ToArray();
        int Find(int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; }

        // a face of a cube is identified by the sorted ids of its 8 nodes; two cubes that share all 8 are linked there
        var faces = new Dictionary<string, List<(int Cube, int Face)>>();
        for (int e = 0; e < cubes; e++)
            for (int f = 0; f < 6; f++)
            {
                string key = string.Join(',', ElementLocal.FaceNodes[f].Select(s => coarse.Connectivity[e * 20 + s]).OrderBy(i => i));
                if (!faces.TryGetValue(key, out var list)) faces[key] = list = new();
                list.Add((e, f));
            }
        foreach (var list in faces.Values)
            foreach (var (a, fa) in list)
            {
                if (fa % 2 == 0) continue;                                  // each pair once, from its + face
                foreach (var (b, fb) in list)
                {
                    if (b == a || fb != (fa ^ 1)) continue;
                    var (axis, _) = ElementLocal.FaceAxis(fa);
                    int endA = 2 * Count(axis), endB = 0;
                    foreach (var (ix, iy, iz) in points)
                    {
                        var p = new[] { ix, iy, iz };
                        if (p[axis] != endA) continue;
                        var q = (int[])p.Clone();
                        q[axis] = endB;
                        parent[Find(a * g + gridIndex[(p[0], p[1], p[2])])] = Find(b * g + gridIndex[(q[0], q[1], q[2])]);
                    }
                }
            }

        // ---- compact node numbering, positions from the shape functions -----------------------------------
        var nodeOfRoot = new Dictionary<int, int>();
        var positions = new List<double[]>();
        var gridNodes = new int[cubes * g];
        for (int e = 0; e < cubes; e++)
        {
            var corners = new double[20][];
            for (int s = 0; s < 20; s++)
            {
                int node = coarse.Connectivity[e * 20 + s];
                corners[s] = new[] { coarse.Positions[node * 3], coarse.Positions[node * 3 + 1], coarse.Positions[node * 3 + 2] };
            }
            for (int i = 0; i < g; i++)
            {
                int root = Find(e * g + i);
                if (!nodeOfRoot.TryGetValue(root, out int n))
                {
                    n = nodeOfRoot[root] = positions.Count;
                    var phi = ElementLocal.ShapeFunctions((double)points[i].X / Nx - 1, (double)points[i].Y / Ny - 1, (double)points[i].Z / Nz - 1);
                    var position = new double[3];
                    for (int s = 0; s < 20; s++)
                        for (int c = 0; c < 3; c++) position[c] += phi[s] * corners[s][c];
                    positions.Add(position);
                }
                gridNodes[e * g + i] = n;
            }
        }

        // ---- the small elements ---------------------------------------------------------------------------
        int per = Nx * Ny * Nz, count = cubes * per;
        var connectivity = new int[count, 20];
        var roots = new int[count];
        var keys = new string[count];
        var boxes = new ParametricBox[count];
        var sides = new string?[count, 6];
        for (int e = 0; e < cubes; e++)
            for (int ez = 0; ez < Nz; ez++)
                for (int ey = 0; ey < Ny; ey++)
                    for (int ex = 0; ex < Nx; ex++)
                    {
                        int fine = e * per + (ez * Ny + ey) * Nx + ex;
                        roots[fine] = e;
                        keys[fine] = $"{coarse.ElementIds[e]}:{ex},{ey},{ez}";
                        boxes[fine] = new ParametricBox(Edge(ex, Nx), Edge(ey, Ny), Edge(ez, Nz), Edge(ex + 1, Nx), Edge(ey + 1, Ny), Edge(ez + 1, Nz));
                        for (int k = 0; k < 20; k++)
                            connectivity[fine, k] = gridNodes[e * g + gridIndex[(2 * ex + ElementLocal.Nodes[k, 0] + 1, 2 * ey + ElementLocal.Nodes[k, 1] + 1, 2 * ez + ElementLocal.Nodes[k, 2] + 1)]];
                        // a face of the element lies on a side of the cube when the element is the last one in that direction
                        var index = new[] { ex, ey, ez };
                        for (int f = 0; f < 6; f++)
                        {
                            var (axis, sign) = ElementLocal.FaceAxis(f);
                            if (index[axis] == (sign < 0 ? 0 : Count(axis) - 1)) sides[fine, f] = ElementLocal.FaceNames[f];
                        }
                    }

        var flat = new double[positions.Count, 3];
        for (int n = 0; n < positions.Count; n++)
            for (int c = 0; c < 3; c++) flat[n, c] = positions[n][c];
        return new FemMesh(flat, connectivity, roots, keys, boxes, sides);
    }

    /// <summary>The coordinate of the i-th of n equal cuts of [-1, 1]; one formula for every place that needs it, so equal places are equal numbers.</summary>
    public static double Edge(int i, int n) => -1.0 + 2.0 * i / n;

    private int Count(int axis) => axis == 0 ? Nx : axis == 1 ? Ny : Nz;

    /// <summary>The existing grid points (ix, iy, iz) of a divided cube - at most one odd index - iz slowest, ix fastest.</summary>
    public static (int X, int Y, int Z)[] GridPoints(int nx, int ny, int nz)
    {
        var points = new List<(int, int, int)>();
        for (int iz = 0; iz <= 2 * nz; iz++)
            for (int iy = 0; iy <= 2 * ny; iy++)
                for (int ix = 0; ix <= 2 * nx; ix++)
                    if ((ix % 2) + (iy % 2) + (iz % 2) <= 1) points.Add((ix, iy, iz));
        return points.ToArray();
    }
}
