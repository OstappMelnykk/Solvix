namespace Refinement2D.Core;

/// <summary>What one pass did, for showing and for checking.</summary>
/// <param name="Unreached">The cells the user chose (or what they became) that this pass could not cut across the axis: neighbours that are cut the other way, or are cut across themselves, leave no seam for them.</param>
public sealed record PassTrace(
    int Axis, int N,
    IReadOnlyList<int> MarkedNodes,
    IReadOnlyList<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Applied,
    IReadOnlyList<int> MarkedAfter,
    IReadOnlyList<int> Unreached);

public sealed record RefineResult(IReadOnlyList<PassTrace> Passes);

/// <summary>
/// Local two-dimensional refinement with transition templates. For each axis in turn (I, then J): mark the nodes on the seams between
/// even-odd pairs of coarse layers that hold a marked cell, split every cell that has marked nodes by the template its pattern needs,
/// and add the cells just split to the marked set. A cell of the marked set ends up cut into nI x nJ; the cells round it receive
/// templates so that no node of a finer cell hangs on the edge of a coarser one.
/// </summary>
public static class Refiner
{
    public static RefineResult Refine(QuadMesh mesh, IEnumerable<int> markedCells, int nI, int nJ)
    {
        if (nI < 2 || nJ < 2) throw new ArgumentOutOfRangeException(nameof(nI), "n must be at least 2.");
        var marked = markedCells.ToHashSet();
        var required = marked.ToHashSet();                            // the cells the user chose, and what they become: these must be cut in full
        foreach (int id in marked) if (!mesh.Cells.ContainsKey(id)) throw new ArgumentException($"Unknown cell {id}.");
        var passes = new List<PassTrace>();
        for (int axis = 0; axis < 2; axis++) passes.Add(Pass(mesh, marked, required, axis, axis == 0 ? nI : nJ));
        return new RefineResult(passes);
    }

    /// <summary>One pass along an axis: rescale by n, mark, complete, give the cells of M a seam of their own where the layers gave none, apply the templates, expand M.</summary>
    public static PassTrace Pass(QuadMesh mesh, HashSet<int> marked, HashSet<int> required, int axis, int n)
    {
        mesh.Rescale(n);
        var nodes = MarkNodes(mesh, marked, axis);
        Complete(mesh, nodes);
        ExtendForMarkedCells(mesh, marked, required, axis, nodes);
        var unreached = required.Where(id => !IsCutAcross(mesh.Cells[id], nodes, axis)).OrderBy(x => x).ToList();
        var applied = Apply(mesh, nodes, n, marked);
        foreach (var a in applied)
            if (required.Remove(a.Cell)) required.UnionWith(a.Children);
        return new PassTrace(axis, n, nodes.OrderBy(x => x).ToList(), applied, marked.OrderBy(x => x).ToList(), unreached);
    }

    // ---- marking -------------------------------------------------------------------------------------------------------

    /// <summary>
    /// The nodes on the seams of the coarse layer pairs along `axis` that hold a marked cell. The layers are numbered by their position in the
    /// coarse lattice and taken in the pairs (0, 1), (2, 3), ... everywhere in the grid, so the seams of neighbouring chains line up even
    /// across holes (the book numbers the layers globally for the same reason). The seam of a pair is the edge its two layers share; a layer
    /// whose partner is missing still has that edge as its seam. Every lattice node on the seam - those that earlier refinements put there
    /// too - is marked.
    /// </summary>
    public static HashSet<int> MarkNodes(QuadMesh mesh, ISet<int> marked, int axis)
    {
        var active = marked.Select(id => mesh.Cells[id].Root).ToHashSet();
        var marks = new HashSet<int>();
        long d = mesh.Scale;
        foreach (var root in mesh.Roots)
        {
            if (!active.Contains(root.Id)) continue;
            int layer = axis == 0 ? root.I : root.J;
            bool even = ((layer % 2) + 2) % 2 == 0;
            long seam = (layer + (even ? 1 : 0)) * d;                                      // the shared edge of the pair (layer, layer + 1) or (layer - 1, layer)
            long low = (axis == 0 ? root.J : root.I) * d, high = low + d;
            for (int id = 0; id < mesh.Nodes.Count; id++)
            {
                var p = mesh.Nodes[id];
                long along = axis == 0 ? p.X : p.Y, across = axis == 0 ? p.Y : p.X;
                if (along == seam && across >= low && across <= high) marks.Add(id);
            }
        }
        return marks;
    }

    // ---- patterns, completion, and the cells of M that the seams did not reach ----------------------------------------------

    // The marked slots of a cell, in increasing order.
    private static List<int> MarkedSlots(Cell cell, ISet<int> marks) => Enumerable.Range(0, 4).Where(s => marks.Contains(cell.Nodes[s])).ToList();

    /// <summary>
    /// A cell can be refined by a template only when its marked nodes make no marks, one corner, one edge (two adjacent nodes), or all four.
    /// A template cuts exactly the edges that have one marked end, so neighbours that agree on the marks agree on the cuts: any marked node
    /// set whose patterns are all of these four kinds gives a conforming mesh. Three marks, or two on a diagonal, are completed by marking
    /// the missing nodes (the book's rules of section 4.9 are special cases); that can change the pattern of the cells round those nodes,
    /// so it is repeated until nothing changes.
    /// </summary>
    public static void Complete(QuadMesh mesh, HashSet<int> marks) => Complete(mesh, marks, CellsByNode(mesh));

    private static void Complete(QuadMesh mesh, HashSet<int> marks, Dictionary<int, List<int>> cellsOf)
    {
        var queue = new Queue<int>(marks.SelectMany(n => cellsOf.GetValueOrDefault(n) ?? new List<int>()).Distinct());
        while (queue.Count > 0)
        {
            var cell = mesh.Cells[queue.Dequeue()];
            var slots = MarkedSlots(cell, marks);
            bool diagonal = slots.Count == 2 && (slots[1] - slots[0]) == 2;
            if (slots.Count != 3 && !diagonal) continue;
            foreach (int node in cell.Nodes)
                if (marks.Add(node))
                    foreach (int other in cellsOf.GetValueOrDefault(node) ?? new List<int>()) queue.Enqueue(other);
        }
    }

    private static Dictionary<int, List<int>> CellsByNode(QuadMesh mesh)
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

    // Is the cell cut into strips across the axis: marked edge on the left or right (axis 0), at the bottom or the top (axis 1)?
    private static bool IsCutAcross(Cell cell, ISet<int> marks, int axis)
    {
        var slots = MarkedSlots(cell, marks);
        return slots.Count == 2 && (axis == 0 ? slots.SequenceEqual(new[] { 1, 2 }) || slots.SequenceEqual(new[] { 0, 3 })
                                              : slots.SequenceEqual(new[] { 0, 1 }) || slots.SequenceEqual(new[] { 2, 3 }));
    }

    /// <summary>
    /// A cell of M has to be cut in n along this axis, which needs a marked edge across it. The seams of the coarse layers reach most of them;
    /// those that they do not (a cell deeper in its coarse cell than the seam, one that got a corner or the wrong edge) get a seam of their
    /// own: one of their two edges across the axis. Which, is decided by the parity of the cell's place in the lattice of its own size along
    /// the axis (even: the far edge, odd: the near one), the same pairing as the coarse layers use; the other edge is tried if the first
    /// would break a pattern. A cell that cannot be reached either way is left, and reported by the check of M.
    /// </summary>
    private static void ExtendForMarkedCells(QuadMesh mesh, ISet<int> marked, ISet<int> required, int axis, HashSet<int> marks)
    {
        var cellsOf = CellsByNode(mesh);
        foreach (int id in required.OrderBy(x => x).ToList())
        {
            var cell = mesh.Cells[id];
            if (IsCutAcross(cell, marks, axis)) continue;
            var far = axis == 0 ? new[] { 1, 2 } : new[] { 2, 3 };
            var near = axis == 0 ? new[] { 0, 3 } : new[] { 0, 1 };
            var points = cell.Nodes.Select(mesh.PointOf).ToArray();
            long low = points.Min(p => axis == 0 ? p.X : p.Y), high = points.Max(p => axis == 0 ? p.X : p.Y);
            long width = high - low;
            bool even = width > 0 && (((low / width) % 2) + 2) % 2 == 0;
            foreach (var edge in even ? new[] { far, near } : new[] { near, far })
            {
                var trial = new HashSet<int>(marks);
                foreach (int slot in edge) trial.Add(cell.Nodes[slot]);
                Complete(mesh, trial, cellsOf);
                var others = required.Where(m => m != id && IsCutAcross(mesh.Cells[m], marks, axis)).ToList();
                if (!IsCutAcross(cell, trial, axis)) continue;
                if (others.Any(m => !IsCutAcross(mesh.Cells[m], trial, axis))) continue;           // it must not spoil another cell of the user's that was fine
                marks.Clear();
                marks.UnionWith(trial);
                break;
            }
        }
    }

    // ---- templates -----------------------------------------------------------------------------------------------------

    private static List<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Apply(QuadMesh mesh, HashSet<int> marks, int n, HashSet<int> marked)
    {
        var applied = new List<(int, string, int, IReadOnlyList<int>)>();
        foreach (var cell in mesh.Cells.Values.OrderBy(c => c.Id).ToList())
        {
            var slots = Enumerable.Range(0, 4).Where(s => marks.Contains(cell.Nodes[s])).ToList();
            if (slots.Count == 0 || slots.Count == 4) continue;                        // untouched, or already all marked
            List<Cell> children;
            string name;
            int index;
            switch (slots.Count)
            {
                case 1:
                    (name, index) = ("T1", slots[0]);
                    children = Templates.ApplyCorner(mesh, cell, slots[0], n);
                    break;
                case 2 when (slots[1] - slots[0] + 4) % 4 is 1 or 3:
                    // the marked edge (e, e + 1); slots are sorted, so (0, 3) is the edge 3
                    index = slots[1] - slots[0] == 1 ? slots[0] : slots[1];
                    (name, children) = ("T2", Templates.ApplyEdge(mesh, cell, index, n));
                    break;
                default:
                    throw new InvalidOperationException($"Cell {cell.Id} has an impossible pattern of {slots.Count} marked nodes ({string.Join(",", slots)}).");
            }
            mesh.RemoveCell(cell.Id);
            foreach (var child in children) mesh.AddToRoot(child);
            marked.Remove(cell.Id);
            foreach (var child in children) marked.Add(child.Id);                    // Expand: what was just refined joins the marked set
            applied.Add((cell.Id, name, index, children.Select(c => c.Id).ToList()));
        }
        return applied;
    }
}
