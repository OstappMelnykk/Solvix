namespace Solvix.FemMesh.Local;

/// <summary>What one pass did, for showing and for checking.</summary>
/// <param name="Unreached">The cells of M (the user's, or what they became) that this pass could not cut across its axis.</param>
public sealed record PassTrace(
    int Axis, int N,
    IReadOnlyList<int> MarkedNodes,
    IReadOnlyList<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Applied,
    IReadOnlyList<int> Unreached);

public sealed record RefineResult(IReadOnlyList<PassTrace> Passes);

/// <summary>
/// A step in choosing the seams of the cells of M that the coarse layers did not reach. Kind "guess": the first choice for the cell by the parity of its
/// place (side 0 or 1: the face on that side of the axis is marked; it is kept only if it cuts the cell and spoils no cell that was cut), kind "refused": a
/// first choice that did not cut the cell or spoiled another. Kind "change": the search found that choosing otherwise for this cell cuts more cells
/// of M (side -1: the cell gets no seam of its own and is cut by the marks of its neighbours). Added: the nodes the completion had to add because of the
/// choice; Uncut: the cells of M that are still not cut across the axis once the choice is made.
/// </summary>
public sealed record SeamTry(int Cell, int Side, string Kind, IReadOnlyList<int> FaceNodes, IReadOnlyList<int> Added, bool CutAcross, IReadOnlyList<int> Uncut);

/// <summary>
/// One stage of a refinement, for showing it step by step: the mesh as it was then, the nodes marked, the cells in M, and what the templates did.
/// Kinds: "start" (the cells chosen), "layers" (the seams of the coarse layers are marked and completed; the unreached cells are those they did not
/// reach), "seam" (one attempt at a seam of a cell's own; the mesh is that of the last "layers" stage), "marks" (all marks of the pass are final),
/// "templates" (applied), "expand" (what was just refined has joined M), "final".
/// </summary>
public sealed record RefineStep(
    string Kind, int Axis, int N,
    HexMesh? Mesh,
    IReadOnlyList<int> Marked,
    IReadOnlyList<int> M,
    IReadOnlyList<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Applied,
    IReadOnlyList<int> Unreached,
    SeamTry? Try = null);

/// <summary>
/// Local three-dimensional refinement with transition templates. For each axis in turn (I, J, K): mark the nodes on the seams between even-odd
/// pairs of coarse layers that hold a cell of M, complete the marks to patterns that have a template, split every cell with marked nodes by its
/// template, and add the cells just split to M. The book adds all of them after every pass, so the transition layers are refined again in the next
/// passes and the refinement spreads over several layers; here that is the depth of the transition zone: 2 is the book (after the passes I and J), 0 adds
/// only what comes from the cells the user chose (the refinement stays in the cells round them), 1 does it after the pass I only. A cell of M ends up cut into nI x nJ x nK; the cells round it get templates so that no node of a
/// finer cell hangs on the face of a coarser one.
/// </summary>
public static class Refiner
{
    /// <summary>
    /// The lattice gets finer by a factor nI x nJ x nK with every refinement, and its coordinates have to stay exact integers that the checks can multiply:
    /// below 2^40. A refinement that would go over it is refused before anything is changed.
    /// </summary>
    public static void EnsureFine(HexMesh mesh, int nI, int nJ, int nK)
    {
        long biggest = mesh.Nodes.Count == 0 ? 1 : mesh.Nodes.Max(p => Math.Max(p.X, Math.Max(p.Y, p.Z)));
        Int128 after = (Int128)biggest * nI * nJ * nK;
        if (after > (1L << 40))
            throw new InvalidOperationException($"The lattice is too fine for another refinement ({nI}x{nJ}x{nK} would make it {after} units across a cell of the coarse grid's size {mesh.Scale}); undo some refinements or use a smaller n.");
    }

    public static RefineResult Refine(HexMesh mesh, IEnumerable<int> markedCells, int nI, int nJ, int nK, int transitionDepth = 0)
    {
        if (nI < 2 || nJ < 2 || nK < 2) throw new ArgumentOutOfRangeException(nameof(nI), "n must be at least 2.");
        if (transitionDepth < 0 || transitionDepth > 2) throw new ArgumentOutOfRangeException(nameof(transitionDepth), "the depth of the transition zone is 0, 1 or 2.");
        EnsureFine(mesh, nI, nJ, nK);
        var marked = markedCells.ToHashSet();
        foreach (int id in marked) if (!mesh.Cells.ContainsKey(id)) throw new ArgumentException($"Unknown cell {id}.");
        var required = marked.ToHashSet();                            // the cells the user chose, and what they become: these must be cut in full
        var passes = new List<PassTrace>();
        var ns = new[] { nI, nJ, nK };
        for (int axis = 0; axis < 3; axis++) passes.Add(Pass(mesh, marked, required, axis, ns[axis], null, axis < transitionDepth));
        return new RefineResult(passes);
    }

    /// <summary>The refinement of a copy of the mesh, recorded stage by stage; the mesh itself is not changed. The last stage is the result.</summary>
    public static List<RefineStep> Preview(HexMesh mesh, IEnumerable<int> markedCells, int nI, int nJ, int nK, int transitionDepth = 0)
    {
        if (nI < 2 || nJ < 2 || nK < 2) throw new ArgumentOutOfRangeException(nameof(nI), "n must be at least 2.");
        if (transitionDepth < 0 || transitionDepth > 2) throw new ArgumentOutOfRangeException(nameof(transitionDepth), "the depth of the transition zone is 0, 1 or 2.");
        EnsureFine(mesh, nI, nJ, nK);
        var copy = mesh.Clone();
        var marked = markedCells.ToHashSet();
        foreach (int id in marked) if (!copy.Cells.ContainsKey(id)) throw new ArgumentException($"Unknown cell {id}.");
        var required = marked.ToHashSet();
        var none = Array.Empty<(int, string, int, IReadOnlyList<int>)>();
        var steps = new List<RefineStep> { new("start", -1, 0, copy.Clone(), Array.Empty<int>(), marked.OrderBy(x => x).ToList(), none, Array.Empty<int>()) };
        var ns = new[] { nI, nJ, nK };
        for (int axis = 0; axis < 3; axis++) Pass(copy, marked, required, axis, ns[axis], steps, axis < transitionDepth);
        steps.Add(new RefineStep("final", -1, 0, copy.Clone(), Array.Empty<int>(), Array.Empty<int>(), none, Array.Empty<int>()));
        return steps;
    }

    /// <summary>One pass along an axis: rescale by n, mark, complete, give the cells of M a seam of their own where the layers gave none, apply the templates, expand M.</summary>
    public static PassTrace Pass(HexMesh mesh, HashSet<int> marked, HashSet<int> required, int axis, int n, List<RefineStep>? steps = null, bool expandTransitions = false)
    {
        mesh.Rescale(n);
        var cellsOf = CellsByNode(mesh);
        // what the coarse layers mark for every cell of M (shown to the user), and what stays fixed: the seams of the cells of M that the user did not choose
        // (the transition cells of an earlier pass); the chosen cells themselves take their faces from the search below
        var layered = MarkNodes(mesh, marked, axis);
        Complete(mesh, layered, cellsOf);
        var nodes = MarkNodes(mesh, marked.Where(id => !required.Contains(id)).ToHashSet(), axis);
        Complete(mesh, nodes, cellsOf);
        var none = Array.Empty<(int, string, int, IReadOnlyList<int>)>();
        Action<SeamTry>? log = null;
        if (steps != null)
        {
            var reached = required.Where(id => !IsCutAcross(mesh.Cells[id], layered, axis)).OrderBy(x => x).ToList();
            var shownMarks = layered.OrderBy(x => x).ToList();
            steps.Add(new RefineStep("layers", axis, n, mesh.Clone(), shownMarks, marked.OrderBy(x => x).ToList(), none, reached));
            log = t => steps.Add(new RefineStep("seam", axis, n, null, shownMarks, marked.OrderBy(x => x).ToList(), none, reached, t));
        }
        SeamSolver.Solve(mesh, required, axis, nodes, cellsOf, log);
        EnsureValid(mesh, nodes, cellsOf, n);
        var unreached = required.Where(id => !IsCutAcross(mesh.Cells[id], nodes, axis)).OrderBy(x => x).ToList();
        steps?.Add(new RefineStep("marks", axis, n, mesh.Clone(), nodes.OrderBy(x => x).ToList(), marked.OrderBy(x => x).ToList(), none, unreached));
        var applied = Apply(mesh, nodes, n);
        steps?.Add(new RefineStep("templates", axis, n, mesh.Clone(), nodes.OrderBy(x => x).ToList(), marked.Where(mesh.Cells.ContainsKey).OrderBy(x => x).ToList(), applied, unreached));
        foreach (var a in applied)
        {
            bool wasMine = required.Contains(a.Cell);
            marked.Remove(a.Cell);
            if (expandTransitions || wasMine) marked.UnionWith(a.Children);               // the book: everything refined joins M; otherwise only what comes from the user's cells
            if (required.Remove(a.Cell)) required.UnionWith(a.Children);
        }
        steps?.Add(new RefineStep("expand", axis, n, mesh.Clone(), Array.Empty<int>(), marked.OrderBy(x => x).ToList(), applied, unreached));
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

    internal static int MaskOf(Cell cell, ISet<int> marks)
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

    // seeds: the nodes just marked, when the marks before them already had patterns with templates everywhere (then only the cells round the seeds can be wrong)
    internal static void Complete(HexMesh mesh, HashSet<int> marks, Dictionary<int, List<int>> cellsOf, IEnumerable<int>? seeds = null, List<int>? added = null)
    {
        var queue = new Queue<int>((seeds ?? marks).SelectMany(n => cellsOf.GetValueOrDefault(n) ?? new List<int>()).Distinct());
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
                added?.Add(cell.Nodes[s]);
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

    internal static Dictionary<int, List<int>> CellsByNode(HexMesh mesh)
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
    internal static bool IsCutAcross(Cell cell, ISet<int> marks, int axis)
    {
        int mask = MaskOf(cell, marks);
        return mask == Hex.FaceMask(axis, 0) || mask == Hex.FaceMask(axis, 1);
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
