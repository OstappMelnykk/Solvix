using Solvix.Contracts.Facades;

namespace Solvix.Solver;

/// <summary>
/// The mesh the solver really works on: every cube of the editor cut into nx*ny*nz elements, exactly as the
/// solver's own mesh generator does it. Each small element has its own 20 nodes; the nodes sit on a grid of
/// (2n+1) points per axis of which only those with at most one odd index exist (corners and edge midpoints of
/// the small cells), each at the shape-function image of its place in the cube: x = sum N20(ix/nx-1, iy/ny-1, iz/nz-1) * x_parent.
/// Nodes on a face shared by two linked cubes are one node, so the whole body stays one connected mesh.
/// </summary>
internal sealed class FineMesh
{
    // Local (alpha, beta, gamma) of the 20 nodes: corners then edge midpoints, as in the solver.
    private static readonly int[,] Local =
    {
        { -1, -1, -1 }, { +1, -1, -1 }, { +1, +1, -1 }, { -1, +1, -1 },
        { -1, -1, +1 }, { +1, -1, +1 }, { +1, +1, +1 }, { -1, +1, +1 },
        {  0, -1, -1 }, { +1,  0, -1 }, {  0, +1, -1 }, { -1,  0, -1 },
        {  0, -1, +1 }, { +1,  0, +1 }, {  0, +1, +1 }, { -1,  0, +1 },
        { -1, -1,  0 }, { +1, -1,  0 }, { +1, +1,  0 }, { -1, +1,  0 },
    };

    public required int NodeCount { get; init; }
    public required int ElementCount { get; init; }
    public required double[,] Positions { get; init; }
    public required int[,] Connectivity { get; init; }
    /// <summary>The cube (index into the mesh's element list) each small element belongs to.</summary>
    public required int[] ParentOf { get; init; }
    public required int[] Ex { get; init; }
    public required int[] Ey { get; init; }
    public required int[] Ez { get; init; }
    public required (int Nx, int Ny, int Nz) Divisions { get; init; }
    /// <summary>For each cube, the node of every existing grid point, in the canonical order of <see cref="GridPoints"/>.</summary>
    public required int[] GridNodes { get; init; }
    public required int GridPointCount { get; init; }
    /// <summary>For each small element of a cube: its index inside the cube's nx*ny*nz block.</summary>
    public int ElementsPerCube => Divisions.Nx * Divisions.Ny * Divisions.Nz;

    /// <summary>The existing grid points (ix, iy, iz) of a divided cube, iz slowest and ix fastest.</summary>
    public static (int X, int Y, int Z)[] GridPoints(int nx, int ny, int nz)
    {
        var points = new List<(int, int, int)>();
        for (int iz = 0; iz <= 2 * nz; iz++)
            for (int iy = 0; iy <= 2 * ny; iy++)
                for (int ix = 0; ix <= 2 * nx; ix++)
                    if ((ix % 2) + (iy % 2) + (iz % 2) <= 1) points.Add((ix, iy, iz));
        return points.ToArray();
    }

    public static FineMesh Build(FemMeshDto mesh, int nx, int ny, int nz)
    {
        int cubes = mesh.ElementCount;
        var points = GridPoints(nx, ny, nz);
        int g = points.Length;
        var gridIndex = new Dictionary<(int, int, int), int>();
        for (int i = 0; i < g; i++) gridIndex[points[i]] = i;

        // ---- which nodes are one: unite the grid points on every face that two cubes share --------------
        var parent = Enumerable.Range(0, cubes * g).ToArray();
        int Find(int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; }

        // a face is identified by the (sorted) ids of its 8 parent nodes; two cubes that share all 8 are linked there
        var faces = new Dictionary<string, List<(int Cube, int Face)>>();
        for (int e = 0; e < cubes; e++)
            for (int f = 0; f < 6; f++)
            {
                string key = string.Join(',', FaceSlots[f].Select(s => mesh.Connectivity[e * 20 + s]).OrderBy(i => i));
                if (!faces.TryGetValue(key, out var list)) faces[key] = list = new();
                list.Add((e, f));
            }
        foreach (var list in faces.Values)
        {
            foreach (var (a, fa) in list)
            {
                if (fa % 2 == 0) continue;                                  // handle each pair once, from its + face
                foreach (var (b, fb) in list)
                {
                    if (b == a || fb != (fa ^ 1)) continue;
                    int axis = fa / 2;
                    int endA = 2 * N(axis, nx, ny, nz), endB = 0;
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
        }

        // ---- compact node numbering, positions from the shape functions ------------------------------------
        var nodeOfRoot = new Dictionary<int, int>();
        var positions = new List<double[]>();
        var gridNodes = new int[cubes * g];
        for (int e = 0; e < cubes; e++)
        {
            var corners = new double[20][];
            for (int s = 0; s < 20; s++)
            {
                int node = mesh.Connectivity[e * 20 + s];
                corners[s] = new[] { mesh.Positions[node * 3], mesh.Positions[node * 3 + 1], mesh.Positions[node * 3 + 2] };
            }
            for (int i = 0; i < g; i++)
            {
                int root = Find(e * g + i);
                if (!nodeOfRoot.TryGetValue(root, out int n))
                {
                    n = nodeOfRoot[root] = positions.Count;
                    var phi = ShapeFunctions((double)points[i].X / nx - 1, (double)points[i].Y / ny - 1, (double)points[i].Z / nz - 1);
                    var position = new double[3];
                    for (int s = 0; s < 20; s++)
                        for (int c = 0; c < 3; c++) position[c] += phi[s] * corners[s][c];
                    positions.Add(position);
                }
                gridNodes[e * g + i] = n;
            }
        }

        // ---- the small elements ---------------------------------------------------------------------------
        int per = nx * ny * nz, count = cubes * per;
        var connectivity = new int[count, 20];
        var parentOf = new int[count]; var exs = new int[count]; var eys = new int[count]; var ezs = new int[count];
        for (int e = 0; e < cubes; e++)
            for (int ez = 0; ez < nz; ez++)
                for (int ey = 0; ey < ny; ey++)
                    for (int ex = 0; ex < nx; ex++)
                    {
                        int fine = e * per + (ez * ny + ey) * nx + ex;
                        parentOf[fine] = e; exs[fine] = ex; eys[fine] = ey; ezs[fine] = ez;
                        for (int k = 0; k < 20; k++)
                            connectivity[fine, k] = gridNodes[e * g + gridIndex[(2 * ex + Local[k, 0] + 1, 2 * ey + Local[k, 1] + 1, 2 * ez + Local[k, 2] + 1)]];
                    }

        var flat = new double[positions.Count, 3];
        for (int n = 0; n < positions.Count; n++)
            for (int c = 0; c < 3; c++) flat[n, c] = positions[n][c];
        return new FineMesh
        {
            NodeCount = positions.Count, ElementCount = count, Positions = flat, Connectivity = connectivity,
            ParentOf = parentOf, Ex = exs, Ey = eys, Ez = ezs, Divisions = (nx, ny, nz), GridNodes = gridNodes, GridPointCount = g,
        };
    }

    private static int N(int axis, int nx, int ny, int nz) => axis == 0 ? nx : axis == 1 ? ny : nz;

    // The 8 slots on each face, in the editor's face order: XMinus, XPlus, YMinus, YPlus, ZMinus, ZPlus.
    private static readonly int[][] FaceSlots = Enumerable.Range(0, 6).Select(f =>
        Enumerable.Range(0, 20).Where(s => Local[s, f / 2] == (f % 2 == 0 ? -1 : 1)).ToArray()).ToArray();

    /// <summary>The small element behind the small face (p, q) of a side of a cube, and the solver's local face index it shows outwards.</summary>
    public (int Element, int SolverFace) BoundaryElement(int cube, string face, int p, int q)
    {
        int axis = face[0] - 'X', plus = face.EndsWith("Plus") ? 1 : 0;
        var (nx, ny, nz) = Divisions;
        var counts = new[] { nx, ny, nz };
        var tangents = Enumerable.Range(0, 3).Where(d => d != axis).ToArray();
        var index = new int[3];
        index[axis] = plus == 1 ? counts[axis] - 1 : 0;
        index[tangents[0]] = p;
        index[tangents[1]] = q;
        return (cube * ElementsPerCube + (index[2] * ny + index[1]) * nx + index[0], SolverFaces.TryParse(face, out int sf) ? sf : -1);
    }

    /// <summary>Which small elements of a cube lie on a face of the cube, with the solver's local face index each shows outwards.</summary>
    public IEnumerable<(int Element, int SolverFace)> BoundaryElements(int cube, string face)
    {
        int axis = face[0] - 'X', plus = face.EndsWith("Plus") ? 1 : 0;
        int solverFace = SolverFaces.TryParse(face, out int sf) ? sf : -1;
        var (nx, ny, nz) = Divisions;
        int last = N(axis, nx, ny, nz) - 1;
        for (int i = 0; i < ElementsPerCube; i++)
        {
            int fine = cube * ElementsPerCube + i;
            int index = axis == 0 ? Ex[fine] : axis == 1 ? Ey[fine] : Ez[fine];
            if (index == (plus == 1 ? last : 0)) yield return (fine, solverFace);
        }
    }

    // 20-node serendipity shape functions (the solver's N20).
    internal static double[] ShapeFunctions(double a, double b, double g)
    {
        var phi = new double[20];
        for (int i = 0; i < 8; i++)
        {
            double ai = Local[i, 0], bi = Local[i, 1], gi = Local[i, 2];
            phi[i] = 0.125 * (1 + ai * a) * (1 + bi * b) * (1 + gi * g) * (ai * a + bi * b + gi * g - 2);
        }
        for (int i = 8; i < 20; i++)
        {
            double ai = Local[i, 0], bi = Local[i, 1], gi = Local[i, 2];
            phi[i] = 0.25 * (ai == 0 ? 1 - a * a : 1 + ai * a) * (bi == 0 ? 1 - b * b : 1 + bi * b) * (gi == 0 ? 1 - g * g : 1 + gi * g);
        }
        return phi;
    }
}
