namespace Solvix.FemMesh.Local;

/// <summary>A point of the integer lattice. Coordinates are in 1/Scale of a coarse cell, so every node of every refinement is exact.</summary>
public readonly record struct Pt3(long X, long Y, long Z)
{
    public static Pt3 operator +(Pt3 a, Pt3 b) => new(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
    public static Pt3 operator -(Pt3 a, Pt3 b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
    public long this[int axis] => axis == 0 ? X : axis == 1 ? Y : Z;
}

/// <summary>
/// Everything about the eight slots of a hexahedron. Slot = bit0 + 2 bit1 + 4 bit2, where bit k says on which side of the cell's axis k the corner lies
/// (0: the minus side, 1: the plus side). The axes of every cell are the axes of the lattice, so neighbouring cells always share their orientation.
/// </summary>
public static class Hex
{
    public static int Bit(int slot, int axis) => (slot >> axis) & 1;

    /// <summary>The four slots of the face on the given side (0 or 1) of the given axis.</summary>
    public static int[] FaceSlots(int axis, int side) => Enumerable.Range(0, 8).Where(s => Bit(s, axis) == side).ToArray();

    /// <summary>The same as a bit mask over the eight slots.</summary>
    public static int FaceMask(int axis, int side) => FaceSlots(axis, side).Aggregate(0, (m, s) => m | 1 << s);

    /// <summary>The two axes other than the given one, in increasing order.</summary>
    public static (int U, int V) Others(int axis) => axis switch { 0 => (1, 2), 1 => (0, 2), _ => (0, 1) };
}

/// <summary>One leaf cell: eight nodes in the order of <see cref="Hex"/>.</summary>
public sealed class Cell
{
    public int Id { get; init; }
    public int[] Nodes { get; init; } = new int[8];
    /// <summary>The coarse (root) cell this one lies in. The hierarchy is flat: a root and its leaves.</summary>
    public int Root { get; init; }
}

/// <summary>A cell of the original coarse grid at (I, J, K), with the flat list of the leaves that now fill it.</summary>
public sealed class Root
{
    public int Id { get; init; }
    public int I { get; init; }
    public int J { get; init; }
    public int K { get; init; }
    public int Layer(int axis) => axis == 0 ? I : axis == 1 ? J : K;
    public List<int> Leaves { get; } = new();
}

/// <summary>
/// A hexahedral mesh on an integer lattice, made of the leaves of a coarse grid. Nodes are identified by their position, so two cells
/// meeting at a point share that node by construction.
/// </summary>
public sealed class LatticeMesh
{
    private readonly List<Pt3> _nodes = new();
    private Dictionary<Pt3, int> _index = new();
    private readonly Dictionary<int, Cell> _cells = new();
    private readonly List<Root> _roots = new();
    private int _nextCell;

    /// <summary>Lattice units in the edge of one coarse cell. Grows by the factor n of every pass.</summary>
    public long Scale { get; private set; } = 1;

    public IReadOnlyList<Pt3> Nodes => _nodes;
    public IReadOnlyDictionary<int, Cell> Cells => _cells;
    public IReadOnlyList<Root> Roots => _roots;

    public Pt3 PointOf(int node) => _nodes[node];

    public int NodeAt(Pt3 p)
    {
        if (_index.TryGetValue(p, out int id)) return id;
        id = _nodes.Count;
        _nodes.Add(p);
        _index[p] = id;
        return id;
    }

    /// <summary>A coarse grid of nx x ny x nz unit cells without the cells listed in <paramref name="holes"/> (as (i, j, k)).</summary>
    public static LatticeMesh Grid(int nx, int ny, int nz, IEnumerable<(int I, int J, int K)>? holes = null)
    {
        if (nx < 1 || ny < 1 || nz < 1) throw new ArgumentException("A grid needs at least one cell.");
        var skip = (holes ?? Array.Empty<(int, int, int)>()).ToHashSet();
        var mesh = new LatticeMesh();
        for (int k = 0; k < nz; k++)
            for (int j = 0; j < ny; j++)
                for (int i = 0; i < nx; i++)
                {
                    if (skip.Contains((i, j, k))) continue;
                    var root = new Root { Id = mesh._roots.Count, I = i, J = j, K = k };
                    mesh._roots.Add(root);
                    var corners = Enumerable.Range(0, 8).Select(s => new Pt3(i + Hex.Bit(s, 0), j + Hex.Bit(s, 1), k + Hex.Bit(s, 2))).ToArray();
                    root.Leaves.Add(mesh.AddCell(root.Id, corners).Id);
                }
        if (mesh._roots.Count == 0) throw new ArgumentException("A grid with every cell a hole is empty.");
        return mesh;
    }

    /// <summary>A coarse grid of the given unit cells (any places of the lattice, also negative ones); root number i is the i-th cell.</summary>
    public static LatticeMesh FromCells(IReadOnlyList<(int I, int J, int K)> cells)
    {
        if (cells.Count == 0) throw new ArgumentException("A mesh needs at least one cell.");
        var mesh = new LatticeMesh();
        for (int r = 0; r < cells.Count; r++)
        {
            var (i, j, k) = cells[r];
            var root = new Root { Id = r, I = i, J = j, K = k };
            mesh._roots.Add(root);
            var corners = Enumerable.Range(0, 8).Select(s => new Pt3(i + Hex.Bit(s, 0), j + Hex.Bit(s, 1), k + Hex.Bit(s, 2))).ToArray();
            root.Leaves.Add(mesh.AddCell(root.Id, corners).Id);
        }
        return mesh;
    }

    /// <summary>Adds a leaf from its eight corners given in slot order.</summary>
    public Cell AddCell(int root, Pt3[] corners)
    {
        if (corners.Length != 8) throw new ArgumentException("A hexahedron has eight corners.");
        var cell = new Cell { Id = _nextCell++, Root = root, Nodes = corners.Select(NodeAt).ToArray() };
        _cells[cell.Id] = cell;
        return cell;
    }

    /// <summary>Removes a leaf (it is replaced by its children): from the cells and from its root's list.</summary>
    public void RemoveCell(int id)
    {
        var cell = _cells[id];
        _cells.Remove(id);
        _roots[cell.Root].Leaves.Remove(id);
    }

    public void AddToRoot(Cell cell) => _roots[cell.Root].Leaves.Add(cell.Id);

    /// <summary>Multiplies every coordinate (and the scale) by <paramref name="factor"/>, so that points at k/factor of an edge become lattice points.</summary>
    public void Rescale(long factor)
    {
        if (factor < 1) throw new ArgumentOutOfRangeException(nameof(factor));
        if (factor == 1) return;
        for (int i = 0; i < _nodes.Count; i++) _nodes[i] = new Pt3(checked(_nodes[i].X * factor), checked(_nodes[i].Y * factor), checked(_nodes[i].Z * factor));
        _index = new Dictionary<Pt3, int>(_nodes.Count);
        for (int i = 0; i < _nodes.Count; i++) _index[_nodes[i]] = i;
        Scale = checked(Scale * factor);
    }

    /// <summary>A copy that can be changed without touching this one (the undo step).</summary>
    public LatticeMesh Clone()
    {
        var copy = new LatticeMesh { Scale = Scale, _nextCell = _nextCell };
        copy._nodes.AddRange(_nodes);
        copy._index = new Dictionary<Pt3, int>(_index);
        foreach (var r in _roots)
        {
            var root = new Root { Id = r.Id, I = r.I, J = r.J, K = r.K };
            root.Leaves.AddRange(r.Leaves);
            copy._roots.Add(root);
        }
        foreach (var (id, c) in _cells) copy._cells[id] = new Cell { Id = c.Id, Root = c.Root, Nodes = (int[])c.Nodes.Clone() };
        return copy;
    }

    public Pt3[] CornersOf(Cell cell) => cell.Nodes.Select(PointOf).ToArray();
}
