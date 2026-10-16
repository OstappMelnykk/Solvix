using Solvix.Contracts.Facades;
using Solvix.FemMesh;
using FemFace = Solvix.FemMesh.ElementFace;

namespace Solvix.Solver;

/// <summary>
/// The mesh of finite elements as the rest of the app sees it, and the way back: what the user points at in it (a face, an element, by key) becomes a place in a cube
/// that the setup keeps. Faces and elements are named by the key the mesh gives them, never by an index, so a request made against an old picture of the mesh
/// finds what it named or nothing, and never something else.
/// </summary>
internal static class SolverMeshView
{
    public static SolverMeshDto Of(SolverSetup setup, FemMeshDto coarse)
    {
        if (coarse.ElementCount == 0)
            return new SolverMeshDto(setup.Rule().Name, 0, 0, Array.Empty<double>(), Array.Empty<int>(), Array.Empty<int>(), Array.Empty<string>(), Array.Empty<string>(),
                Array.Empty<int>(), Array.Empty<int>(), Array.Empty<int>(), Array.Empty<double>());
        var built = SolverMeshes.Build(setup, coarse);
        var mesh = built.Mesh;
        var problem = SolverFacade.BuildInput(setup, coarse, built);

        var positions = new double[3 * mesh.NodeCount];
        for (int n = 0; n < mesh.NodeCount; n++)
            for (int c = 0; c < 3; c++) positions[3 * n + c] = mesh.Positions[n, c];
        var connectivity = new int[20 * mesh.ElementCount];
        for (int e = 0; e < mesh.ElementCount; e++)
            for (int k = 0; k < 20; k++) connectivity[20 * e + k] = mesh.Connectivity[e, k];
        static int[] Pairs(IEnumerable<(int Element, int Face)> faces) => faces.SelectMany(f => new[] { f.Element, f.Face }).ToArray();

        return new SolverMeshDto(
            setup.Rule().Name, mesh.NodeCount, mesh.ElementCount, positions, connectivity,
            Enumerable.Range(0, mesh.ElementCount).Select(e => coarse.ElementIds[mesh.RootOf(e)]).ToArray(),
            Enumerable.Range(0, mesh.ElementCount).Select(mesh.KeyOf).ToArray(),
            problem.Model.Materials.Select(m => m.Name).ToArray(),
            Pairs(mesh.SurfaceFaces().Select(f => (f.Element, f.Face))),
            Pairs(problem.Loads.Fixed.Select(f => (f.Element, f.Face))),
            Pairs(problem.Loads.Pressures.Select(p => (p.Face.Element, p.Face.Face))),
            problem.Loads.Pressures.Select(p => p.Pn).ToArray());
    }

    /// <summary>The faces that were pointed at, as places on sides of cubes: only faces that lie on a side of a cube, and that the mesh has, count.</summary>
    public static IEnumerable<(int Hex, string Side, Selections.Shape Shape)> FacesOf(IFemMesh mesh, FemMeshDto coarse, IReadOnlyList<ElementFaceRefDto> faces)
    {
        var byKey = KeysOf(mesh);
        var onSide = new Dictionary<(int Root, string Side), HashSet<FemFace>>();
        var seen = new HashSet<(int, int)>();
        foreach (var reference in faces)
        {
            if (reference.Face < 0 || reference.Face > 5 || !byKey.TryGetValue(reference.Key, out int element) || !seen.Add((element, reference.Face))) continue;
            int root = mesh.RootOf(element);
            string side = ElementLocal.FaceNames[reference.Face];
            if (!onSide.TryGetValue((root, side), out var set)) onSide[(root, side)] = set = mesh.FacesOnSide(root, side).ToHashSet();
            var face = new FemFace(element, reference.Face);
            if (!set.Contains(face)) continue;
            yield return (coarse.ElementIds[root], side, Selections.Shape.OfFace(mesh, face));
        }
    }

    /// <summary>The elements that were pointed at, as places in cubes.</summary>
    public static IEnumerable<(int Hex, Selections.Shape Shape)> ElementsOf(IFemMesh mesh, FemMeshDto coarse, IReadOnlyList<string> keys)
    {
        var byKey = KeysOf(mesh);
        foreach (var key in keys.Distinct())
            if (byKey.TryGetValue(key, out int element)) yield return (coarse.ElementIds[mesh.RootOf(element)], Selections.Shape.OfElement(mesh, element));
    }

    private static Dictionary<string, int> KeysOf(IFemMesh mesh)
    {
        var byKey = new Dictionary<string, int>(mesh.ElementCount);
        for (int e = 0; e < mesh.ElementCount; e++) byKey[mesh.KeyOf(e)] = e;
        return byKey;
    }
}
