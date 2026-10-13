namespace Refinement3D.Core;

/// <summary>
/// Gives every cell of M a way to be cut across the axis of a pass. A cell is cut across when exactly one of its two faces across the axis is marked
/// (then the template is T4: n slabs). The coarse layers' seams give most cells such a face: the one lying on the seam of their layer pair. The rest -
/// cells deeper in their coarse cell than the seam, and cells of later passes whose neighbours are of other sizes - need a choice, and the choices of
/// neighbouring cells depend on each other: a face that is marked puts marks on the nodes of every neighbour, and a neighbour that gets a mark outside
/// its own face is not cut any more. So the choices are searched for together: the cells are taken one after another (the face on the seam first, else by
/// the parity of the cell's place in the lattice of its own size, the same even-odd pairing as the coarse layers; then the other face), a choice that makes
/// any cell of M lose its pattern is undone, and when neither face works the search goes back to the cell before. The cells are split into groups that can
/// influence each other (they touch a common cell), and every group is searched on its own, in the order of the cells' numbers - so the result does not
/// depend on the order the cells were given in. A group that has no solution (or is too big for the search) is treated greedily: a cell that cannot be cut
/// without spoiling another one is left, and reported by the pass.
/// </summary>
internal static class SeamSolver
{
    private const int SearchLimit = 3000;                              // the biggest group searched with going back (the search is recursive)

    public static void Solve(HexMesh mesh, ISet<int> required, int axis, HashSet<int> marks, Dictionary<int, List<int>> cellsOf, Action<SeamTry>? log)
    {
        var all = required.OrderBy(x => x).ToList();
        var forced = new HashSet<int>(marks);
        var decided = new Dictionary<int, int>();                      // required cell -> the side of its face, for cells cut already and those chosen so far
        foreach (int id in all)
        {
            int mask = Refiner.MaskOf(mesh.Cells[id], forced);
            if (mask == Hex.FaceMask(axis, 0)) decided[id] = 0;
            else if (mask == Hex.FaceMask(axis, 1)) decided[id] = 1;
        }
        var need = all.Where(id => !decided.ContainsKey(id)).ToList();
        if (need.Count == 0) return;

        var first = new Dictionary<int, int>();                       // the side tried first
        foreach (int id in need) first[id] = FirstSide(mesh, id, axis);

        var chosen = new Dictionary<int, int>();
        foreach (var group in Groups(mesh, need, cellsOf))
        {
            var found = group.Count <= SearchLimit ? Search(mesh, required, group, first, marks, decided, axis, cellsOf) : null;
            if (found != null) { foreach (var (id, side) in found) chosen[id] = side; continue; }
            foreach (var (id, side) in Greedy(mesh, required, group, first, marks, decided, axis, cellsOf)) chosen[id] = side;
        }

        if (log == null) return;
        // the story for the page: the choices one after the other, each with the marks of all the choices before it
        var running = new Dictionary<int, int>();
        foreach (int id in need)
        {
            int side = chosen.GetValueOrDefault(id, -1);
            if (side >= 0) running[id] = side;
            var trial = new HashSet<int>(forced);
            var seeds = new List<int>();
            foreach (var (other, s) in running.OrderBy(kv => kv.Key))
                foreach (int slot in Hex.FaceSlots(axis, s)) if (trial.Add(mesh.Cells[other].Nodes[slot])) seeds.Add(mesh.Cells[other].Nodes[slot]);
            Refiner.Complete(mesh, trial, cellsOf, seeds);
            int shown = side >= 0 ? side : first[id];
            var own = Hex.FaceSlots(axis, shown).Select(slot => mesh.Cells[id].Nodes[slot]).ToList();
            var uncut = required.Where(r => !Refiner.IsCutAcross(mesh.Cells[r], trial, axis)).OrderBy(x => x).ToList();
            string kind = side < 0 ? "refused" : side == first[id] ? "guess" : "change";
            log(new SeamTry(id, shown, kind, own, trial.Where(x => !forced.Contains(x) && !own.Contains(x)).OrderBy(x => x).ToList(), Refiner.IsCutAcross(mesh.Cells[id], trial, axis), uncut));
        }
    }

    // the face on the seam of the cell's layer pair, if it has one; else by parity
    private static int FirstSide(HexMesh mesh, int id, int axis)
    {
        var cell = mesh.Cells[id];
        int layer = mesh.Roots[cell.Root].Layer(axis);
        bool even = ((layer % 2) + 2) % 2 == 0;
        long seam = (layer + (even ? 1 : 0)) * mesh.Scale;
        for (int side = 0; side < 2; side++)
            if (Hex.FaceSlots(axis, side).All(slot => mesh.PointOf(cell.Nodes[slot])[axis] == seam)) return side;
        var coords = cell.Nodes.Select(n => mesh.PointOf(n)[axis]).ToArray();
        long low = coords.Min(), width = coords.Max() - low;
        return width > 0 && (((low / width) % 2) + 2) % 2 == 0 ? 1 : 0;
    }

    // cells that touch a common cell are in one group
    private static List<List<int>> Groups(HexMesh mesh, List<int> need, Dictionary<int, List<int>> cellsOf)
    {
        var parent = need.ToDictionary(id => id, id => id);
        int Find(int x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
        var owner = new Dictionary<int, int>();                        // a mesh cell -> a cell of `need` that touches it
        foreach (int id in need)
            foreach (int node in mesh.Cells[id].Nodes)
                foreach (int c in cellsOf[node])
                    if (owner.TryGetValue(c, out int other)) { int a = Find(id), b = Find(other); if (a != b) parent[Math.Max(a, b)] = Math.Min(a, b); }
                    else owner[c] = id;
        return need.GroupBy(Find).OrderBy(g => g.Min()).Select(g => g.OrderBy(x => x).ToList()).ToList();
    }

    // marks the face of a cell and completes; the nodes that became marked are returned so that it can be undone
    private static List<int> Mark(HexMesh mesh, int id, int side, HashSet<int> marks, int axis, Dictionary<int, List<int>> cellsOf)
    {
        var added = new List<int>();
        foreach (int slot in Hex.FaceSlots(axis, side))
            if (marks.Add(mesh.Cells[id].Nodes[slot])) added.Add(mesh.Cells[id].Nodes[slot]);
        Refiner.Complete(mesh, marks, cellsOf, added.ToList(), added);
        return added;
    }

    // is every decided cell still marked exactly on its face after these nodes were added?
    private static bool Consistent(HexMesh mesh, List<int> added, Dictionary<int, int> decided, int axis, Dictionary<int, List<int>> cellsOf)
    {
        foreach (int node in added)
            foreach (int c in cellsOf[node])
                if (decided.TryGetValue(c, out int side) && !Hex.FaceSlots(axis, side).Any(slot => mesh.Cells[c].Nodes[slot] == node)) return false;
        return true;
    }

    private static Dictionary<int, int>? Search(HexMesh mesh, ISet<int> required, List<int> group, Dictionary<int, int> first, HashSet<int> marks, Dictionary<int, int> decided, int axis, Dictionary<int, List<int>> cellsOf)
    {
        int budget = 4000 + 200 * group.Count;
        var chosen = new Dictionary<int, int>();
        bool Go(int i)
        {
            if (i == group.Count) return true;
            int id = group[i];
            foreach (int side in new[] { first[id], 1 - first[id] })
            {
                if (budget-- <= 0) return false;
                var added = Mark(mesh, id, side, marks, axis, cellsOf);
                decided[id] = side;
                if (Refiner.IsCutAcross(mesh.Cells[id], marks, axis) && Consistent(mesh, added, decided, axis, cellsOf))
                {
                    chosen[id] = side;
                    if (Go(i + 1)) return true;
                    chosen.Remove(id);
                }
                decided.Remove(id);
                foreach (int node in added) marks.Remove(node);
                if (budget <= 0) return false;
            }
            return false;
        }
        if (Go(0)) return chosen;
        foreach (int id in group) decided.Remove(id);
        return null;
    }

    // no exact choice: one cell after another, the first side that cuts the cell and spoils none that is cut; a cell with no such side is left
    private static Dictionary<int, int> Greedy(HexMesh mesh, ISet<int> required, List<int> group, Dictionary<int, int> first, HashSet<int> marks, Dictionary<int, int> decided, int axis, Dictionary<int, List<int>> cellsOf)
    {
        var chosen = new Dictionary<int, int>();
        foreach (int id in group)
            foreach (int side in new[] { first[id], 1 - first[id] })
            {
                var added = Mark(mesh, id, side, marks, axis, cellsOf);
                decided[id] = side;
                if (Refiner.IsCutAcross(mesh.Cells[id], marks, axis) && Consistent(mesh, added, decided, axis, cellsOf)) { chosen[id] = side; break; }
                decided.Remove(id);
                foreach (int node in added) marks.Remove(node);
            }
        return chosen;
    }
}
