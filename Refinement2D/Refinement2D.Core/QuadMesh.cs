namespace Refinement2D.Core;

/// <summary>A point of the integer lattice. Coordinates are in 1/Scale of a coarse cell, so every node of every refinement is exact.</summary>
public readonly record struct Pt(long X, long Y);

/// <summary>
/// One leaf cell: four nodes in the canonical order, slot 0 = (-, -), 1 = (+, -), 2 = (+, +), 3 = (-, +) of its own axes (which are the
/// axes of the lattice: counter-clockwise, slot 0 -> 1 pointing along +x, slot 0 -> 3 along +y). Neighbouring cells therefore share
/// their orientation, as the cubes of Solvix do.
/// </summary>
public sealed class Cell
{
    public int Id { get; init; }
    public int[] Nodes { get; init; } = new int[4];
    /// <summary>The coarse (root) cell this one lies in: the grouping key of the layers. The hierarchy is flat: a root and its leaves.</summary>
    public int Root { get; init; }
}

/// <summary>A cell of the original coarse grid at lattice position (I, J), with the flat list of the leaf cells that now fill it.</summary>
public sealed class Root
{
    public int Id { get; init; }
    public int I { get; init; }
    public int J { get; init; }
    public List<int> Leaves { get; } = new();
}

/// <summary>
/// A quadrilateral mesh on an integer lattice, made of the leaves of a coarse grid. Nodes are identified by their position, so two
/// cells meeting at a point share that node by construction; a mesh is conforming when no node lies on the inside of a cell's edge.
/// </summary>
public sealed class QuadMesh
{
    private readonly List<Pt> _nodes = new();
    private Dictionary<Pt, int> _index = new();
    private readonly Dictionary<int, Cell> _cells = new();
    private readonly List<Root> _roots = new();
    private int _nextCell;

    /// <summary>Lattice units in the edge of one coarse cell. Grows by the factor n of every pass.</summary>
    public long Scale { get; private set; } = 1;

    public IReadOnlyList<Pt> Nodes => _nodes;
    public IReadOnlyDictionary<int, Cell> Cells => _cells;
    public IReadOnlyList<Root> Roots => _roots;

    public Pt PointOf(int node) => _nodes[node];

    public int NodeAt(Pt p)
    {
        if (_index.TryGetValue(p, out int id)) return id;
        id = _nodes.Count;
        _nodes.Add(p);
        _index[p] = id;
        return id;
    }

    /// <summary>A rectangular coarse grid of nx x ny cells, without the cells listed in <paramref name="holes"/> (as (i, j)).</summary>
    public static QuadMesh Grid(int nx, int ny, IEnumerable<(int I, int J)>? holes = null)
    {
        if (nx < 1 || ny < 1) throw new ArgumentException("A grid needs at least one cell.");
        var skip = (holes ?? Array.Empty<(int, int)>()).ToHashSet();
        var mesh = new QuadMesh();
        for (int j = 0; j < ny; j++)
            for (int i = 0; i < nx; i++)
            {
                if (skip.Contains((i, j))) continue;
                var root = new Root { Id = mesh._roots.Count, I = i, J = j };
                mesh._roots.Add(root);
                var cell = mesh.AddCell(root.Id, new Pt(i, j), new Pt(i + 1, j), new Pt(i + 1, j + 1), new Pt(i, j + 1));
                root.Leaves.Add(cell.Id);
            }
        if (mesh._roots.Count == 0) throw new ArgumentException("A grid with every cell a hole is empty.");
        return mesh;
    }

    /// <summary>Adds a leaf from four points given in cyclic order (either way round); they are put in the canonical order.</summary>
    public Cell AddCell(int root, Pt a, Pt b, Pt c, Pt d)
    {
        var points = Canonical(new[] { a, b, c, d });
        var cell = new Cell { Id = _nextCell++, Root = root, Nodes = points.Select(NodeAt).ToArray() };
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
        for (int i = 0; i < _nodes.Count; i++) _nodes[i] = new Pt(_nodes[i].X * factor, _nodes[i].Y * factor);
        _index = new Dictionary<Pt, int>();
        for (int i = 0; i < _nodes.Count; i++) _index[_nodes[i]] = i;
        Scale = checked(Scale * factor);
    }

    /// <summary>A copy that can be changed without touching this one (the undo step).</summary>
    public QuadMesh Clone()
    {
        var copy = new QuadMesh { Scale = Scale, _nextCell = _nextCell };
        copy._nodes.AddRange(_nodes);
        copy._index = new Dictionary<Pt, int>(_index);
        foreach (var r in _roots)
        {
            var root = new Root { Id = r.Id, I = r.I, J = r.J };
            root.Leaves.AddRange(r.Leaves);
            copy._roots.Add(root);
        }
        foreach (var (id, c) in _cells) copy._cells[id] = new Cell { Id = c.Id, Root = c.Root, Nodes = (int[])c.Nodes.Clone() };
        return copy;
    }

    public IEnumerable<Pt> Corners(Cell cell) => cell.Nodes.Select(PointOf);

    // ---- the canonical order of a cell's slots ------------------------------------------------------------------------

    /// <summary>
    /// Four points of a convex quadrilateral in cyclic order, as the slots of a cell: counter-clockwise, starting at the corner for which
    /// the first edge points most along +x and the last most along +y.
    /// </summary>
    public static Pt[] Canonical(Pt[] cycle)
    {
        long area2 = 0;
        for (int i = 0; i < 4; i++) area2 += cycle[i].X * cycle[(i + 1) % 4].Y - cycle[(i + 1) % 4].X * cycle[i].Y;
        if (area2 == 0) throw new InvalidOperationException("A cell has no area.");
        var ccw = area2 > 0 ? cycle : new[] { cycle[3], cycle[2], cycle[1], cycle[0] };
        int best = 0;
        double bestScore = double.NegativeInfinity;
        for (int r = 0; r < 4; r++)
        {
            var p0 = ccw[r];
            var e01 = Sub(ccw[(r + 1) % 4], p0);
            var e03 = Sub(ccw[(r + 3) % 4], p0);
            double score = e01.X / Math.Sqrt((double)e01.X * e01.X + (double)e01.Y * e01.Y) + e03.Y / Math.Sqrt((double)e03.X * e03.X + (double)e03.Y * e03.Y);
            if (score > bestScore + 1e-12) { bestScore = score; best = r; }
        }
        return Enumerable.Range(0, 4).Select(k => ccw[(best + k) % 4]).ToArray();
    }

    private static Pt Sub(Pt a, Pt b) => new(a.X - b.X, a.Y - b.Y);
}
