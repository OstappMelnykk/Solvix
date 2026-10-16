namespace Solvix.FemMesh;

/// <summary>
/// The plain implementation of <see cref="IFemMesh"/>: arrays that a refinement rule has produced. The neighbours of an element are found here,
/// once, from the nodes alone (two elements are neighbours across a face when they share all of its 8 nodes), so every rule gets them for free
/// and no rule can get them wrong in its own way.
/// </summary>
public sealed class FemMesh : IFemMesh
{
    private readonly int[] _root;
    private readonly string[] _key;
    private readonly ParametricPoint[] _centre;
    private readonly ParametricPoint[] _faceCentre;        // [element * 6 + face]
    private readonly ParametricPoint[][] _corners;
    private readonly Dictionary<int, List<int>> _elementsOfRoot = new();
    private readonly Dictionary<(int Root, int Side), List<ElementFace>> _facesOnSide = new();
    private readonly ElementFace?[] _neighbour;            // [element * 6 + face]
    private readonly int[] _side;                          // [element * 6 + face]: the editor side (index into SideNames) the face lies on, or -1

    private static readonly string[] SideNames = { "XMinus", "XPlus", "YMinus", "YPlus", "ZMinus", "ZPlus" };

    /// <param name="side">For every face of every element ([element, solver face]): the side of the editor cube it lies on (as the editor names it), or null.</param>
    public FemMesh(double[,] positions, int[,] connectivity, int[] root, string[] key, ParametricPoint[] centre, ParametricPoint[,] faceCentre, ParametricPoint[][] corners, string?[,] side)
    {
        Positions = positions;
        Connectivity = connectivity;
        NodeCount = positions.GetLength(0);
        ElementCount = connectivity.GetLength(0);
        if (root.Length != ElementCount || key.Length != ElementCount || centre.Length != ElementCount || faceCentre.GetLength(0) != ElementCount || corners.Length != ElementCount || side.GetLength(0) != ElementCount)
            throw new ArgumentException("Every element needs its cube, its key, its centres and its sides.");
        _root = root;
        _key = key;
        _centre = centre;
        _faceCentre = new ParametricPoint[ElementCount * 6];
        _corners = corners;
        for (int e = 0; e < ElementCount; e++)
            for (int f = 0; f < 6; f++) _faceCentre[e * 6 + f] = faceCentre[e, f];
        _side = new int[ElementCount * 6];
        for (int e = 0; e < ElementCount; e++)
            for (int f = 0; f < 6; f++) _side[e * 6 + f] = side[e, f] is { } name ? Array.IndexOf(SideNames, name) : -1;
        _neighbour = FindNeighbours();
        for (int e = 0; e < ElementCount; e++)
        {
            if (!_elementsOfRoot.TryGetValue(_root[e], out var list)) _elementsOfRoot[_root[e]] = list = new();
            list.Add(e);
            for (int f = 0; f < 6; f++)
            {
                if (_side[e * 6 + f] < 0) continue;
                var at = (_root[e], _side[e * 6 + f]);
                if (!_facesOnSide.TryGetValue(at, out var faces)) _facesOnSide[at] = faces = new();
                faces.Add(new ElementFace(e, f));
            }
        }
    }

    public int NodeCount { get; }
    public int ElementCount { get; }
    public double[,] Positions { get; }
    public int[,] Connectivity { get; }

    public int RootOf(int element) => _root[element];

    public string KeyOf(int element) => _key[element];

    public ParametricPoint CentreOf(int element) => _centre[element];

    public ParametricPoint FaceCentreOf(ElementFace face) => _faceCentre[face.Element * 6 + face.Face];

    public IReadOnlyList<ParametricPoint> CornersOf(int element) => _corners[element];

    public IReadOnlyList<int> ElementsOf(int root) => _elementsOfRoot.TryGetValue(root, out var list) ? list : Array.Empty<int>();

    public ElementFace? Neighbour(ElementFace face) => _neighbour[face.Element * 6 + face.Face];

    public IEnumerable<ElementFace> SurfaceFaces()
    {
        for (int e = 0; e < ElementCount; e++)
            for (int f = 0; f < 6; f++)
                if (_neighbour[e * 6 + f] is null) yield return new ElementFace(e, f);
    }

    public IEnumerable<ElementFace> FacesOnSide(int root, string side)
    {
        int index = Array.IndexOf(SideNames, side);
        return index >= 0 && _facesOnSide.TryGetValue((root, index), out var faces) ? faces : Enumerable.Empty<ElementFace>();
    }

    private ElementFace?[] FindNeighbours()
    {
        var result = new ElementFace?[ElementCount * 6];
        var seen = new Dictionary<string, ElementFace>();
        var ids = new int[8];
        for (int e = 0; e < ElementCount; e++)
            for (int f = 0; f < 6; f++)
            {
                var nodes = ElementLocal.FaceNodes[f];
                for (int i = 0; i < 8; i++) ids[i] = Connectivity[e, nodes[i]];
                Array.Sort(ids);
                string key = string.Join(',', ids);
                if (seen.Remove(key, out var other))
                {
                    result[e * 6 + f] = other;
                    result[other.Element * 6 + other.Face] = new ElementFace(e, f);
                }
                else seen[key] = new ElementFace(e, f);
            }
        return result;
    }
}
