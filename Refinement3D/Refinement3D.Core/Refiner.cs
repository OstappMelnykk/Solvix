namespace Refinement3D.Core;

/// <summary>What one pass did, for showing and for checking.</summary>
/// <param name="Unreached">The cells of M (the user's, or what they became) that this pass could not cut across its axis.</param>
public sealed record PassTrace(
    int Axis, int N,
    IReadOnlyList<int> MarkedNodes,
    IReadOnlyList<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Applied,
    IReadOnlyList<int> Unreached);

public sealed record RefineResult(IReadOnlyList<PassTrace> Passes);

/// <summary>
/// Local three-dimensional refinement with transition templates. For each axis in turn (I, J, K): mark the nodes on the seams between even-odd
/// pairs of coarse layers that hold a cell of M, complete the marks to patterns that have a template, split every cell with marked nodes by its
/// template, and add the cells just split to M. A cell of M ends up cut into nI x nJ x nK; the cells round it get templates so that no node of a
/// finer cell hangs on the face of a coarser one.
/// </summary>
public static class Refiner
{
    public static RefineResult Refine(HexMesh mesh, IEnumerable<int> markedCells, int nI, int nJ, int nK)
    {
        if (nI < 2 || nJ < 2 || nK < 2) throw new ArgumentOutOfRangeException(nameof(nI), "n must be at least 2.");
        var marked = markedCells.ToHashSet();
        foreach (int id in marked) if (!mesh.Cells.ContainsKey(id)) throw new ArgumentException($"Unknown cell {id}.");
        var required = marked.ToHashSet();                            // the cells the user chose, and what they become: these must be cut in full
        var passes = new List<PassTrace>();
        var ns = new[] { nI, nJ, nK };
        for (int axis = 0; axis < 3; axis++) passes.Add(Pass(mesh, marked, required, axis, ns[axis]));
        return new RefineResult(passes);
    }

    /// <summary>One pass along an axis: rescale by n, mark, complete, give the cells of M a seam of their own where the layers gave none, apply the templates, expand M.</summary>
    public static PassTrace Pass(HexMesh mesh, HashSet<int> marked, HashSet<int> required, int axis, int n)
    {
        mesh.Rescale(n);
        var cellsOf = CellsByNode(mesh);
        var nodes = MarkNodes(mesh, marked, axis);
        Complete(mesh, nodes, cellsOf);
        ExtendForMarkedCells(mesh, required, axis, nodes, cellsOf);
        EnsureValid(mesh, nodes, cellsOf, n);
        var unreached = required.Where(id => !IsCutAcross(mesh.Cells[id], nodes, axis)).OrderBy(x => x).ToList();
        var applied = Apply(mesh, nodes, n);
        foreach (var a in applied)
        {
            marked.Remove(a.Cell);
            marked.UnionWith(a.Children);
            if (required.Remove(a.Cell)) required.UnionWith(a.Children);
        }
        return new PassTrace(axis, n, nodes.OrderBy(x => x).ToList(), applied, unreached);
    }

    // ---- marking -------------------------------------------------------------------------------------------------------

    /// <summary>
    /// The nodes on the seams of the coarse layer pairs along `axis` that hold a cell of M. The layers are numbered by their position in the coarse lattice
    /// and taken in the pairs (0, 1), (2, 3), ... everywhere in the grid (so the seams line up across holes). The seam of a pair is the plane its two
    /// layers share; a layer whose partner is missing still has that plane as its seam. A cell of M that has a face on its seam marks the four nodes of it.
    /// </summary>
    public static HashSet<int> MarkNodes(HexMesh mesh, ISet<int> marked, int axis)
    {
        var marks = new HashSet<int>();
        long d = mesh.Scale;
        foreach (int id in marked)
        {
            var cell = mesh.Cells[id];
            int layer = mesh.Roots[cell.Root].Layer(axis);
            bool even = ((layer % 2) + 2) % 2 == 0;
            long seam = (layer + (even ? 1 : 0)) * d;
            for (int side = 0; side < 2; side++)
            {
                var face = Hex.FaceSlots(axis, side).Select(s => cell.Nodes[s]).ToArray();
                if (face.All(node => mesh.PointOf(node)[axis] == seam)) marks.UnionWith(face);
            }
        }
        return marks;
    }

    // ---- patterns, completion, and the cells of M that the seams did not reach ----------------------------------------------

    private static int MaskOf(Cell cell, ISet<int> marks)
    {
        int mask = 0;
        for (int s = 0; s < 8; s++) if (marks.Contains(cell.Nodes[s])) mask |= 1 << s;
        return mask;
    }

    /// <summary>
    /// Makes every cell's marks a pattern that has a template (none, a corner, an edge, a face, all): a cell with any other pattern gets its missing nodes
    /// marked - those of the face that holds all its marks, or else all eight. That can change the pattern of the cells round those nodes, so it
    /// is repeated until nothing changes. The result is the smallest such set of marks containing the given ones, whatever the order.
    /// </summary>
    public static void Complete(HexMesh mesh, HashSet<int> marks) => Complete(mesh, marks, CellsByNode(mesh));

    private static void Complete(HexMesh mesh, HashSet<int> marks, Dictionary<int, List<int>> cellsOf)
    {
        var queue = new Queue<int>(marks.SelectMany(n => cellsOf.GetValueOrDefault(n) ?? new List<int>()).Distinct());
        while (queue.Count > 0)
        {
            var cell = mesh.Cells[queue.Dequeue()];
            int mask = MaskOf(cell, marks);
            if (Patterns.KindOf(mask) != Patterns.Kind.Invalid) continue;
            int closed = Patterns.Closure(mask);
            for (int s = 0; s < 8; s++)
            {
                if ((closed >> s & 1) == 0 || marks.Contains(cell.Nodes[s])) continue;
                marks.Add(cell.Nodes[s]);
                foreach (int other in cellsOf.GetValueOrDefault(cell.Nodes[s]) ?? new List<int>()) queue.Enqueue(other);
            }
        }
    }

    /// <summary>
    /// A template on a strongly skewed parent (a leaf of an earlier refinement) can fold a child. A cell whose template would do that gets more marks - the
    /// smallest bigger pattern whose template is valid (all eight marked always is) - and the completion runs again, until every cell's template is valid.
    /// </summary>
    private static void EnsureValid(HexMesh mesh, HashSet<int> marks, Dictionary<int, List<int>> cellsOf, int n)
    {
        var allowed = Enumerable.Range(1, 255).Where(m => Patterns.KindOf(m) != Patterns.Kind.Invalid)
            .OrderBy(m => System.Numerics.BitOperations.PopCount((uint)m)).ThenBy(m => m).ToArray();
        bool changed = true;
        while (changed)
        {
            changed = false;
            foreach (var cell in mesh.Cells.Values.Where(c => c.Nodes.Any(marks.Contains)).OrderBy(c => c.Id).ToList())
            {
                int mask = MaskOf(cell, marks);
                var kind = Patterns.KindOf(mask);
                if (kind is Patterns.Kind.None or Patterns.Kind.All) continue;
                var corners = mesh.CornersOf(cell);
                if (Templates.IsValid(Templates.ChildrenFor(corners, mask, n)!)) continue;
                int better = allowed.First(m => (mask & ~m) == 0 && m != mask && (m == 255 || Templates.IsValid(Templates.ChildrenFor(corners, m, n)!)));
                for (int s = 0; s < 8; s++) if ((better >> s & 1) == 1) marks.Add(cell.Nodes[s]);
                Complete(mesh, marks, cellsOf);
                changed = true;
            }
        }
    }

    private static Dictionary<int, List<int>> CellsByNode(HexMesh mesh)
    {
        var map = new Dictionary<int, List<int>>();
        foreach (var cell in mesh.Cells.Values)
            foreach (int node in cell.Nodes)
            {
                if (!map.TryGetValue(node, out var list)) map[node] = list = new List<int>();
                list.Add(cell.Id);
            }
        return map;
    }

    // Is the cell cut into slabs across the axis: exactly the face on one side of the axis marked?
    private static bool IsCutAcross(Cell cell, ISet<int> marks, int axis)
    {
        int mask = MaskOf(cell, marks);
        return mask == Hex.FaceMask(axis, 0) || mask == Hex.FaceMask(axis, 1);
    }

    /// <summary>
    /// A cell of M has to be cut in n along this axis, which needs exactly one of its two faces across the axis marked. The seams of the coarse layers reach
    /// most of them; those they do not (a cell deeper in its coarse cell than the seam, one that got a corner or an edge) get a seam of their own: one of
    /// their two faces across the axis. Which, is decided by the parity of the cell's place in the lattice of its own size along the axis (even: the far
    /// face, odd: the near one), the same pairing as the coarse layers use; the other face is tried if the first would break a pattern or spoil another
    /// cell of M. A cell that cannot be reached either way is left, and reported.
    /// </summary>
    private static void ExtendForMarkedCells(HexMesh mesh, ISet<int> required, int axis, HashSet<int> marks, Dictionary<int, List<int>> cellsOf)
    {
        foreach (int id in required.OrderBy(x => x).ToList())
        {
            var cell = mesh.Cells[id];
            if (IsCutAcross(cell, marks, axis)) continue;
            var coords = cell.Nodes.Select(n => mesh.PointOf(n)[axis]).ToArray();
            long low = coords.Min(), width = coords.Max() - low;
            bool even = width > 0 && (((low / width) % 2) + 2) % 2 == 0;
            foreach (int side in even ? new[] { 1, 0 } : new[] { 0, 1 })
            {
                var trial = new HashSet<int>(marks);
                foreach (int slot in Hex.FaceSlots(axis, side)) trial.Add(cell.Nodes[slot]);
                Complete(mesh, trial, cellsOf);
                if (!IsCutAcross(cell, trial, axis)) continue;
                // it must not spoil another cell of the user's that was fine
                if (required.Any(m => m != id && IsCutAcross(mesh.Cells[m], marks, axis) && !IsCutAcross(mesh.Cells[m], trial, axis))) continue;
                marks.Clear();
                marks.UnionWith(trial);
                break;
            }
        }
    }

    // ---- templates -----------------------------------------------------------------------------------------------------

    private static List<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Apply(HexMesh mesh, HashSet<int> marks, int n)
    {
        var applied = new List<(int, string, int, IReadOnlyList<int>)>();
        foreach (var cell in mesh.Cells.Values.OrderBy(c => c.Id).ToList())
        {
            int mask = MaskOf(cell, marks);
            var kind = Patterns.KindOf(mask);
            if (kind is Patterns.Kind.None or Patterns.Kind.All) continue;
            List<Cell> children;
            string name;
            int index;
            switch (kind)
            {
                case Patterns.Kind.Corner:
                    index = Patterns.SlotsOf(mask)[0];
                    (name, children) = ("T1", Templates.ApplyCorner(mesh, cell, index, n));
                    break;
                case Patterns.Kind.Edge:
                    var (edgeAxis, start) = Patterns.EdgeOf(mask);
                    index = start;
                    (name, children) = ("T2", Templates.ApplyEdge(mesh, cell, edgeAxis, start, n));
                    break;
                case Patterns.Kind.Face:
                    var (faceAxis, side) = Patterns.FaceOf(mask);
                    index = faceAxis * 2 + side;
                    (name, children) = ("T4", Templates.ApplyFace(mesh, cell, faceAxis, side, n));
                    break;
                default:
                    throw new InvalidOperationException($"Cell {cell.Id} has an impossible pattern of marked nodes ({string.Join(",", Patterns.SlotsOf(mask))}).");
            }
            mesh.RemoveCell(cell.Id);
            foreach (var child in children) mesh.AddToRoot(child);
            applied.Add((cell.Id, name, index, children.Select(c => c.Id).ToList()));
        }
        return applied;
    }
}
