namespace Solvix.FemMesh;

/// <summary>
/// One face of one finite element: the element's number in the mesh and the solver's local face index
/// (0 bottom, 1 top, 2 front, 3 back, 4 left, 5 right; see <see cref="ElementLocal.FaceNames"/>).
/// This is the ONLY way the solver names a face: it never says "the face of the parent cube".
/// </summary>
public readonly record struct ElementFace(int Element, int Face);

/// <summary>
/// The mesh the solver works on: a flat set of 20-node hexahedral finite elements. Nothing here says how the elements came to be -
/// a cube cut evenly, a locally refined body, anything else; for the solver (loads, supports, materials, results, quality) an element
/// is an element. What a mesh knows about its origin is only what the editor needs to map its own choices (a cube, a side of a cube)
/// onto elements, and a stable key to find an element again after the mesh is built anew.
/// </summary>
public interface IFemMesh
{
    int NodeCount { get; }
    int ElementCount { get; }

    /// <summary>Node positions, [node, 0..2].</summary>
    double[,] Positions { get; }

    /// <summary>The 20 nodes of every element, [element, 0..19], in the solver's order (8 corners, then the 12 edge midpoints).</summary>
    int[,] Connectivity { get; }

    /// <summary>The cube of the editor's mesh (its index in the exported mesh) the element lies in.</summary>
    int RootOf(int element);

    /// <summary>Where the centre of the element lies inside its cube, in the cube's own coordinates (see <see cref="ParametricPoint"/>).</summary>
    ParametricPoint CentreOf(int element);

    /// <summary>Where the centre of a face of an element lies inside the cube, in the cube's own coordinates.</summary>
    ParametricPoint FaceCentreOf(ElementFace face);

    /// <summary>The elements that lie in a cube.</summary>
    IReadOnlyList<int> ElementsOf(int root);

    /// <summary>A key of the element that does not change when the mesh is built anew from the same cubes by the same rule.</summary>
    string KeyOf(int element);

    /// <summary>The element behind a face of the element, or null when the face is on the surface of the body.</summary>
    ElementFace? Neighbour(ElementFace face);

    /// <summary>Every face on the surface of the body.</summary>
    IEnumerable<ElementFace> SurfaceFaces();

    /// <summary>The faces that lie on a side of an editor cube (the side, as the editor names it: XMinus, XPlus, YMinus, YPlus, ZMinus, ZPlus), outwards.</summary>
    IEnumerable<ElementFace> FacesOnSide(int root, string side);
}

/// <summary>
/// The way a coarse mesh of the editor is turned into the mesh of finite elements. The solver asks for it and gets a mesh, whatever the rule:
/// <see cref="UniformRefinement"/> cuts every cube the same way, a local refinement would cut a chosen part finer. Rules are interchangeable.
/// </summary>
public interface IMeshRefinement
{
    /// <summary>A short name, for the setup and for messages.</summary>
    string Name { get; }

    IFemMesh Build(Solvix.Contracts.Facades.FemMeshDto coarse);
}
