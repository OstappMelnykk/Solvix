using Solvix.Contracts.Facades;
using Solvix.FemMesh;

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

    /// <summary>The finite-element mesh itself, as the abstraction (<see cref="IFemMesh"/>) the rest of the solver sees.</summary>
    public required IFemMesh Mesh { get; init; }

    /// <summary>
    /// The uniform rule (<see cref="UniformRefinement"/>) applied to the cubes, with the addressing of the uniform cut - the cube of an element,
    /// its index along each axis, the node of each grid point - read off the mesh. The mesh is made by the rule alone; this class no longer
    /// has a generator of its own.
    /// </summary>
    public static FineMesh Build(FemMeshDto mesh, int nx, int ny, int nz) => Of(new UniformRefinement(nx, ny, nz).Build(mesh), mesh, nx, ny, nz);

    /// <summary>The uniform addressing over a mesh that a uniform rule has made.</summary>
    public static FineMesh Of(IFemMesh femMesh, FemMeshDto coarse, int nx, int ny, int nz)
    {
        int count = femMesh.ElementCount;
        var points = GridPoints(nx, ny, nz);
        int g = points.Length;
        var gridIndex = new Dictionary<(int, int, int), int>();
        for (int i = 0; i < g; i++) gridIndex[points[i]] = i;
        var cubeOfId = new Dictionary<int, int>();
        for (int e = 0; e < coarse.ElementCount; e++) cubeOfId[coarse.ElementIds[e]] = e;

        var parentOf = new int[count]; var exs = new int[count]; var eys = new int[count]; var ezs = new int[count];
        var gridNodes = new int[coarse.ElementCount * g];
        for (int fine = 0; fine < count; fine++)
        {
            // the key of an element of the uniform rule is "cube id:ex,ey,ez"
            var key = femMesh.KeyOf(fine);
            int colon = key.IndexOf(':');
            var xyz = key[(colon + 1)..].Split(',').Select(int.Parse).ToArray();
            int cube = cubeOfId[int.Parse(key[..colon])];
            parentOf[fine] = cube; exs[fine] = xyz[0]; eys[fine] = xyz[1]; ezs[fine] = xyz[2];
            for (int k = 0; k < 20; k++)
                gridNodes[cube * g + gridIndex[(2 * xyz[0] + Local[k, 0] + 1, 2 * xyz[1] + Local[k, 1] + 1, 2 * xyz[2] + Local[k, 2] + 1)]] = femMesh.Connectivity[fine, k];
        }
        return new FineMesh
        {
            Mesh = femMesh, NodeCount = femMesh.NodeCount, ElementCount = count, Positions = femMesh.Positions, Connectivity = femMesh.Connectivity,
            ParentOf = parentOf, Ex = exs, Ey = eys, Ez = ezs, Divisions = (nx, ny, nz), GridNodes = gridNodes, GridPointCount = g,
        };
    }

    private static int N(int axis, int nx, int ny, int nz) => axis == 0 ? nx : axis == 1 ? ny : nz;

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

    /// <summary>The 20 node positions of one small element of a cube, without building the whole fine mesh.</summary>
    public static double[,] ElementCoordinates(FemMeshDto mesh, int nx, int ny, int nz, int cube, int ex, int ey, int ez)
    {
        var corners = new double[20][];
        for (int s = 0; s < 20; s++)
        {
            int node = mesh.Connectivity[cube * 20 + s];
            corners[s] = new[] { mesh.Positions[node * 3], mesh.Positions[node * 3 + 1], mesh.Positions[node * 3 + 2] };
        }
        var xyz = new double[20, 3];
        for (int k = 0; k < 20; k++)
        {
            var phi = ShapeFunctions((double)(2 * ex + Local[k, 0] + 1) / nx - 1, (double)(2 * ey + Local[k, 1] + 1) / ny - 1, (double)(2 * ez + Local[k, 2] + 1) / nz - 1);
            for (int c = 0; c < 3; c++)
                for (int s = 0; s < 20; s++) xyz[k, c] += phi[s] * corners[s][c];
        }
        return xyz;
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
