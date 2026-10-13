namespace Refinement2D.Core;

/// <summary>What one pass did, for showing and for checking.</summary>
public sealed record PassTrace(
    int Axis, int N,
    IReadOnlyList<int> MarkedNodes,
    IReadOnlyList<(int Cell, string Template, int Index, IReadOnlyList<int> Children)> Applied,
    IReadOnlyList<int> MarkedAfter);

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
        foreach (int id in marked) if (!mesh.Cells.ContainsKey(id)) throw new ArgumentException($"Unknown cell {id}.");
        var passes = new List<PassTrace>();
        for (int axis = 0; axis < 2; axis++)
        {
            int n = axis == 0 ? nI : nJ;
            mesh.Rescale(n);
            var nodes = MarkNodes(mesh, marked, axis);
            var applied = Apply(mesh, nodes, n, marked);
            passes.Add(new PassTrace(axis, n, nodes.OrderBy(x => x).ToList(), applied, marked.OrderBy(x => x).ToList()));
        }
        return new RefineResult(passes);
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
