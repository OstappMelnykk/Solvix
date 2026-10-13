namespace Refinement2D.Core;

/// <summary>What one pass did, for showing and for checking.</summary>
/// <param name="Unreached">The cells the user chose (or what they became) that this pass could not cut across the axis: neighbours that are cut the other way, or are cut across themselves, leave no seam for them.</param>
public sealed record PassTrace(
    int Axis, int N,
    IReadOnlyList<int> MarkedNodes,
    IReadOnlyList<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Applied,
    IReadOnlyList<int> MarkedAfter,
    IReadOnlyList<int> Unreached);

/// <summary>
/// One attempt to give a cell of M a seam of its own: the edge tried, the nodes the completion had to add, whether the cell is now cut across the
/// axis, which other cells of M that were fine it would spoil, and whether the attempt was kept.
/// </summary>
public sealed record SeamTry(int Cell, string Edge, IReadOnlyList<int> EdgeNodes, IReadOnlyList<int> Added, bool CutAcross, IReadOnlyList<int> Spoiled, bool Accepted);

public sealed record RefineResult(IReadOnlyList<PassTrace> Passes);

/// <summary>
/// One stage of a refinement, for showing it step by step: the mesh as it was then, the nodes marked, the cells in M, and what the templates did.
/// Kinds: "start" (the cells chosen), "marks" (a pass has marked its nodes), "templates" (the templates have been applied),
/// "expand" (what was just refined has joined M), "final". A detailed preview adds, in every pass, "layers" (the seams of the coarse layers
/// are marked, the cells of M they did not reach are the unreached ones) and one "seam" per attempt to give such a cell a seam of its own
/// (the mesh is that of the last "layers" stage).
/// </summary>
public sealed record RefineStep(
    string Kind, int Axis, int N,
    QuadMesh? Mesh,
    IReadOnlyList<int> Marked,
    IReadOnlyList<int> M,
    IReadOnlyList<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Applied,
    IReadOnlyList<int> Unreached,
    SeamTry? Try = null);

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

    /// <summary>The refinement of a copy of the mesh, recorded stage by stage; the mesh itself is not changed. The last stage is the result.</summary>
    public static List<RefineStep> Preview(QuadMesh mesh, IEnumerable<int> markedCells, int nI, int nJ, bool detailed = false)
    {
        var copy = mesh.Clone();
        var marked = markedCells.ToHashSet();
        foreach (int id in marked) if (!copy.Cells.ContainsKey(id)) throw new ArgumentException($"Unknown cell {id}.");
        var required = marked.ToHashSet();
        var none = Array.Empty<(int, string, int, IReadOnlyList<int>)>();
        var steps = new List<RefineStep> { new("start", -1, 0, copy.Clone(), Array.Empty<int>(), marked.OrderBy(x => x).ToList(), none, Array.Empty<int>()) };
        for (int axis = 0; axis < 2; axis++) Pass(copy, marked, required, axis, axis == 0 ? nI : nJ, steps, detailed);
        steps.Add(new RefineStep("final", -1, 0, copy.Clone(), Array.Empty<int>(), Array.Empty<int>(), none, Array.Empty<int>()));
        return steps;
    }

    /// <summary>One pass along an axis: rescale by n, mark, complete, give the cells of M a seam of their own where the layers gave none, apply the templates, expand M.</summary>
    public static PassTrace Pass(QuadMesh mesh, HashSet<int> marked, HashSet<int> required, int axis, int n, List<RefineStep>? steps = null, bool detailed = false)
    {
        mesh.Rescale(n);
        var nodes = MarkNodes(mesh, marked, axis);
        Complete(mesh, nodes);
        Action<SeamTry>? log = null;
        if (steps != null && detailed)
        {
            var reached = required.Where(id => !IsCutAcross(mesh.Cells[id], nodes, axis)).OrderBy(x => x).ToList();
            steps.Add(new RefineStep("layers", axis, n, mesh.Clone(), nodes.OrderBy(x => x).ToList(), marked.OrderBy(x => x).ToList(), Array.Empty<(int, string, int, IReadOnlyList<int>)>(), reached));
            log = t => steps.Add(new RefineStep("seam", axis, n, null, nodes.OrderBy(x => x).ToList(), marked.OrderBy(x => x).ToList(), Array.Empty<(int, string, int, IReadOnlyList<int>)>(), reached, t));
        }
        ExtendForMarkedCells(mesh, marked, required, axis, nodes, log);
        var unreached = required.Where(id => !IsCutAcross(mesh.Cells[id], nodes, axis)).OrderBy(x => x).ToList();
        var noChildren = Array.Empty<(int, string, int, IReadOnlyList<int>)>();
        steps?.Add(new RefineStep("marks", axis, n, mesh.Clone(), nodes.OrderBy(x => x).ToList(), marked.OrderBy(x => x).ToList(), noChildren, unreached));
        var applied = Apply(mesh, nodes, n);
        steps?.Add(new RefineStep("templates", axis, n, mesh.Clone(), nodes.OrderBy(x => x).ToList(), marked.Where(mesh.Cells.ContainsKey).OrderBy(x => x).ToList(), applied, unreached));
        // Expand: what was just refined joins the marked set (and the user's cells become what they were cut into)
        foreach (var a in applied)
        {
            marked.Remove(a.Cell);
            marked.UnionWith(a.Children);
            if (required.Remove(a.Cell)) required.UnionWith(a.Children);
        }
        steps?.Add(new RefineStep("expand", axis, n, mesh.Clone(), Array.Empty<int>(), marked.OrderBy(x => x).ToList(), applied, unreached));
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
        var marks = new HashSet<int>();
        long d = mesh.Scale;
        foreach (int id in marked)
        {
            var cell = mesh.Cells[id];
            var root = mesh.Roots[cell.Root];
            int layer = axis == 0 ? root.I : root.J;
            bool even = ((layer % 2) + 2) % 2 == 0;
            long seam = (layer + (even ? 1 : 0)) * d;                                      // the shared edge of the pair (layer, layer + 1) or (layer - 1, layer)
            var onSeam = cell.Nodes.Select(mesh.PointOf).Where(p => (axis == 0 ? p.X : p.Y) == seam).ToList();
            if (onSeam.Count < 2) continue;                                                 // the cell does not touch the seam: its own seam comes later
            long low = onSeam.Min(p => axis == 0 ? p.Y : p.X), high = onSeam.Max(p => axis == 0 ? p.Y : p.X);
            for (int node = 0; node < mesh.Nodes.Count; node++)
            {
                var p = mesh.Nodes[node];
                long along = axis == 0 ? p.X : p.Y, across = axis == 0 ? p.Y : p.X;
                if (along == seam && across >= low && across <= high) marks.Add(node);
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
    private static void ExtendForMarkedCells(QuadMesh mesh, ISet<int> marked, ISet<int> required, int axis, HashSet<int> marks, Action<SeamTry>? log = null)
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
                var edgeNodes = edge.Select(slot => cell.Nodes[slot]).ToList();
                Complete(mesh, trial, cellsOf);
                var others = required.Where(m => m != id && IsCutAcross(mesh.Cells[m], marks, axis)).ToList();
                bool cut = IsCutAcross(cell, trial, axis);
                var spoiled = others.Where(m => !IsCutAcross(mesh.Cells[m], trial, axis)).ToList();      // it must not spoil another cell of the user's that was fine
                bool accepted = cut && spoiled.Count == 0;
                log?.Invoke(new SeamTry(id, edge == far ? "far" : "near", edgeNodes, trial.Where(x => !marks.Contains(x) && !edgeNodes.Contains(x)).OrderBy(x => x).ToList(), cut, spoiled, accepted));
                if (!accepted) continue;
                marks.Clear();
                marks.UnionWith(trial);
                break;
            }
        }
    }

    // ---- templates -----------------------------------------------------------------------------------------------------

    private static List<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Apply(QuadMesh mesh, HashSet<int> marks, int n)
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
            applied.Add((cell.Id, name, index, children.Select(c => c.Id).ToList()));
        }
        return applied;
    }
}
