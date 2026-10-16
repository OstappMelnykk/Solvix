using Solvix.Contracts.Facades;
using Solvix.FemMesh;
using FemFace = Solvix.Fem.ElementFace;

namespace Solvix.Solver;

/// <summary>
/// The one place where what the user set up (a face cell (p, q) of a side of a cube, a cell (ex, ey, ez) of a cube) meets the mesh of finite
/// elements. A setup cell is a region of the cube in the cube's own coordinates; the faces and elements of the mesh that lie in that region
/// ARE the cell, whatever rule made them. So the same code serves an even cut (a cell is exactly one element) and any finer or irregular
/// mesh (a cell is all the elements that lie in it): the solver never reads "which cube, which p, q" off the mesh itself.
/// A region owns the elements and faces whose centre lies in it - the rule the setup already used when its division changes.
/// </summary>
internal static class SetupBinding
{
    /// <summary>The region of a side of a cube that cell (p, q) of its grid covers: the side's end along its axis, the cell along the two tangent axes.</summary>
    public static ParametricRegion RegionOf(string side, int p, int q, int[] counts)
    {
        int axis = side[0] - 'X';
        var (t0, t1) = Tangents(axis);
        var lo = new double[3];
        var hi = new double[3];
        double end = side.EndsWith("Plus") ? 1 : -1;
        lo[axis] = hi[axis] = end;
        (lo[t0], hi[t0]) = (UniformRefinement.Edge(p, counts[t0]), UniformRefinement.Edge(p + 1, counts[t0]));
        (lo[t1], hi[t1]) = (UniformRefinement.Edge(q, counts[t1]), UniformRefinement.Edge(q + 1, counts[t1]));
        return new ParametricRegion(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    }

    /// <summary>The region of a cube that cell (ex, ey, ez) of its grid covers.</summary>
    public static ParametricRegion RegionOf(ElementKey e, int[] counts) => new(
        UniformRefinement.Edge(e.Ex, counts[0]), UniformRefinement.Edge(e.Ey, counts[1]), UniformRefinement.Edge(e.Ez, counts[2]),
        UniformRefinement.Edge(e.Ex + 1, counts[0]), UniformRefinement.Edge(e.Ey + 1, counts[1]), UniformRefinement.Edge(e.Ez + 1, counts[2]));

    /// <summary>The faces of the mesh that make up cell (p, q) of a side of a cube (an empty list for a side the mesh has nothing on).</summary>
    public static IEnumerable<FemFace> FacesOf(IFemMesh mesh, int cube, string side, int p, int q, int[] counts)
    {
        if (!SolverFaces.IsValid(side)) yield break;
        int axis = side[0] - 'X';
        var (t0, t1) = Tangents(axis);
        var region = RegionOf(side, p, q, counts);
        foreach (var face in mesh.FacesOnSide(cube, side))
        {
            if (ElementLocal.FaceAxis(face.Face).Axis != axis) continue;
            if (region.Owns(mesh.FaceCentreOf(face), new[] { t0, t1 })) yield return new FemFace(face.Element, face.Face);
        }
    }

    /// <summary>The elements of the mesh that make up cell (ex, ey, ez) of a cube.</summary>
    public static IEnumerable<int> ElementsOf(IFemMesh mesh, int cube, ElementKey cell, int[] counts)
    {
        var region = RegionOf(cell, counts);
        foreach (int e in mesh.ElementsOf(cube))
            if (region.Owns(mesh.CentreOf(e), new[] { 0, 1, 2 })) yield return e;
    }

    /// <summary>The cell of a cube's grid that an element lies in (the one that owns its centre).</summary>
    public static ElementKey CellOf(IFemMesh mesh, int element, int hexId, int[] counts)
    {
        var centre = mesh.CentreOf(element);
        int Index(int axis)
        {
            for (int i = 0; i < counts[axis]; i++)
                if (InCell(centre, axis, i, counts[axis])) return i;
            return counts[axis] - 1;
        }
        return new ElementKey(hexId, Index(0), Index(1), Index(2));
    }

    private static bool InCell(ParametricPoint centre, int axis, int i, int n)
    {
        var lo = new double[3]; var hi = new double[3];
        lo[0] = lo[1] = lo[2] = -1; hi[0] = hi[1] = hi[2] = 1;
        lo[axis] = UniformRefinement.Edge(i, n);
        hi[axis] = UniformRefinement.Edge(i + 1, n);
        return new ParametricRegion(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]).Owns(centre, new[] { axis });
    }

    private static (int, int) Tangents(int axis)
    {
        var t = Enumerable.Range(0, 3).Where(d => d != axis).ToArray();
        return (t[0], t[1]);
    }
}
