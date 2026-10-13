namespace Refinement3D.Core;

/// <summary>
/// Settings of the smoothing, the same as in Solvix: how many passes, the step of one pass, how much the density of the nodes is kept (0: plain averaging,
/// 1: the weights 1/L, along a straight line any spacing is left as it is), whether the nodes on the outer surface may slide in the plane of their face,
/// how many passes of the optimization smoothing follow the Laplacian ones (each node is moved to where the cells round it are best, see Smoothing), and the
/// number of threads (-1: as many as there are processors; the result is the same for any number).
/// </summary>
public sealed record SmoothingOptions(int Iterations = 20, double Relaxation = 0.5, double Density = 0.0, bool SlideOnSurface = false, int OptimizationPasses = 0, int MaxThreads = -1);

/// <summary>
/// The quality of the cells. Q of a cell (Solvix's measure) is the smallest Jacobian over the largest one at 27 points (1: a parallelepiped, 0 or less:
/// inverted). The scaled Jacobian of a cell is the smallest, over its eight corners, of det / (|a| |b| |c|) of the three edges at the corner (1: a box,
/// 0 or less: inverted); Poor counts the cells below 0.3 in it.
/// </summary>
public sealed record Quality(double Min, double Mean, int Poor, int Inverted, int Cells, double MinScaled, double MeanScaled);

public sealed record SmoothingResult(double[] Positions, Quality Before, Quality After, int Moved);

/// <summary>
/// Laplacian smoothing of the nodes of a mesh in 3D, keeping the shape of the body. A node on the outer surface (a face with one owner: the outside of
/// the grid and the walls of the holes) is never moved off the surface: by default it does not move at all; with sliding on, a node on a flat face moves
/// in the plane of that face, a node on an edge of the body along that edge, a node on a corner not at all. The nodes inside move to the weighted mean of
/// their neighbours (the ends of the edges they sit on). A node moves only if the worst cell round it does not get worse and the cells round it get better together (the smart Laplacian): no cell is turned inside out, and neither the worst cell nor the mean quality of the mesh gets worse.
/// Positions are in units of the coarse grid (the lattice divided by its scale). Because the surface is kept, the total volume is kept too.
/// </summary>
public static class Smoothing
{
    public static double[] Lattice(HexMesh mesh)
    {
        var p = new double[mesh.Nodes.Count * 3];
        for (int i = 0; i < mesh.Nodes.Count; i++)
            for (int a = 0; a < 3; a++) p[i * 3 + a] = (double)mesh.Nodes[i][a] / mesh.Scale;
        return p;
    }

    /// <summary>For each node the axes (as bits) whose coordinate is pinned by a face of the outer surface that holds the node.</summary>
    public static int[] SurfaceConstraints(HexMesh mesh)
    {
        var owners = new Dictionary<(int, int, int, int), List<(int Cell, int Axis, int Side)>>();
        foreach (var cell in mesh.Cells.Values)
            for (int axis = 0; axis < 3; axis++)
                for (int side = 0; side < 2; side++)
                {
                    var key = Conformity.FaceKey(cell, axis, side);
                    if (!owners.TryGetValue(key, out var list)) owners[key] = list = new();
                    list.Add((cell.Id, axis, side));
                }
        var mask = new int[mesh.Nodes.Count];
        foreach (var list in owners.Values)
        {
            if (list.Count != 1) continue;
            var (cell, axis, side) = list[0];
            var nodes = Hex.FaceSlots(axis, side).Select(s => mesh.Cells[cell].Nodes[s]).ToArray();
            int planeBits = 0;
            for (int a = 0; a < 3; a++)
                if (nodes.All(n => mesh.Nodes[n][a] == mesh.Nodes[nodes[0]][a])) planeBits |= 1 << a;     // the axes in which the face is flat: normally exactly one
            foreach (int n in nodes) mask[n] |= planeBits;
        }
        return mask;
    }

    /// <param name="onPass">Called after every pass with the number of the pass and the positions as they are then (the array is the one being worked on: copy it to keep it).</param>
    /// <param name="start">The positions to go on from (the result of an earlier smoothing); by default the nodes of the lattice, i.e. the mesh as it came out of the refinement. "Before" in the result is always the lattice.</param>
    /// <param name="cancel">When it is set the smoothing stops after the pass it is in, and what has been done is returned.</param>
    public static SmoothingResult Smooth(HexMesh mesh, SmoothingOptions options, Action<int, double[]>? onPass = null, CancellationToken cancel = default, double[]? start = null)
    {
        if (options.Iterations < 0 || options.OptimizationPasses < 0 || options.Relaxation <= 0 || options.Relaxation > 1 || options.Density < 0 || options.Density > 1)
            throw new ArgumentOutOfRangeException(nameof(options), "iterations >= 0, optimization passes >= 0, 0 < relaxation <= 1, 0 <= density <= 1.");
        var lattice = Lattice(mesh);
        var before = QualityOf(mesh, lattice);
        if (start != null && start.Length != lattice.Length) throw new ArgumentException("The starting positions do not belong to this mesh.", nameof(start));
        var pos = start == null ? (double[])lattice.Clone() : (double[])start.Clone();
        var constraint = SurfaceConstraints(mesh);
        var neighbours = Neighbours(mesh);
        var cells = mesh.Cells.Values.OrderBy(c => c.Id).Select(c => c.Nodes).ToArray();
        var cellsOf = new List<int>[mesh.Nodes.Count];
        for (int i = 0; i < cellsOf.Length; i++) cellsOf[i] = new List<int>();
        for (int c = 0; c < cells.Length; c++) foreach (int n in cells[c]) cellsOf[n].Add(c);

        // which axes of a node may change: none on the surface unless sliding is on
        int Free(int node)
        {
            if (constraint[node] == 0) return 7;
            if (!options.SlideOnSurface) return 0;
            return 7 & ~constraint[node];
        }

        // The nodes are grouped in classes of nodes that share no cell, so that the nodes of a class can be moved at the same time (each one sees the
        // moves of the classes before it, and nothing of its own class: the result does not depend on the number of processors).
        var classes = Classes(mesh.Nodes.Count, cells, cellsOf, node => Free(node) != 0 && neighbours[node].Length > 0);
        void Sweep(Func<int, bool> work)
        {
            foreach (var members in classes)
            {
                if (members.Length < 64 || options.MaxThreads == 1) foreach (int n in members) work(n);
                else Parallel.ForEach(members, new ParallelOptions { MaxDegreeOfParallelism = options.MaxThreads }, n => work(n));
            }
        }

        // A node moves to the weighted mean of its neighbours only if the worst of the cells round it (by the scaled Jacobian) does not get worse and the
        // cells round it get better together (their scaled Jacobians add up to more); when not, the step is halved, up to five times, and then the node
        // stays (the "smart" Laplacian). So no cell is turned inside out, the worst cell of the mesh never gets worse, and neither does the mean.
        for (int it = 0; it < options.Iterations; it++)
        {
            int moves = 0;
            Sweep(i =>
            {
                int free = Free(i);
                double sw = 0, sx = 0, sy = 0, sz = 0;
                foreach (int j in neighbours[i])
                {
                    double dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
                    double length = Math.Sqrt(dx * dx + dy * dy + dz * dz);
                    double w = options.Density == 0 || length < 1e-12 ? 1.0 : Math.Pow(length, -options.Density);
                    sw += w; sx += w * pos[j * 3]; sy += w * pos[j * 3 + 1]; sz += w * pos[j * 3 + 2];
                }
                if (sw == 0) return false;
                double mx = (free & 1) != 0 ? options.Relaxation * (sx / sw - pos[i * 3]) : 0;
                double my = (free & 2) != 0 ? options.Relaxation * (sy / sw - pos[i * 3 + 1]) : 0;
                double mz = (free & 4) != 0 ? options.Relaxation * (sz / sw - pos[i * 3 + 2]) : 0;
                if (Math.Abs(mx) + Math.Abs(my) + Math.Abs(mz) < 1e-14) return false;
                var (worst, total) = Local(cellsOf[i], cells, pos);
                double x0 = pos[i * 3], y0 = pos[i * 3 + 1], z0 = pos[i * 3 + 2];
                double f = 1;
                bool accepted = false;
                for (int attempt = 0; attempt < 6 && !accepted; attempt++, f *= 0.5)
                {
                    pos[i * 3] = x0 + f * mx; pos[i * 3 + 1] = y0 + f * my; pos[i * 3 + 2] = z0 + f * mz;
                    var (w2, t2) = Local(cellsOf[i], cells, pos);
                    accepted = w2 >= worst - 1e-12 && t2 > total + 1e-12;                    // the worst cell round the node is not worse, and the cells round it are better together
                }
                if (!accepted) { pos[i * 3] = x0; pos[i * 3 + 1] = y0; pos[i * 3 + 2] = z0; return false; }
                Interlocked.Increment(ref moves);
                return true;
            });
            onPass?.Invoke(it + 1, pos);
            if (moves == 0 || cancel.IsCancellationRequested) break;
        }

        // The optimization passes. The Laplacian smoothing is blind to shape: it only averages, so a cell that is bad because of its corners (a sheared plate,
        // a corner of a template) stays bad when its neighbours are on average where they should be. Here every node is moved to where the cells round it are
        // best: the sum over their corners of (1/s - 1)^2, s the scaled Jacobian at the corner, is made smaller by steepest descent (the gradient taken
        // numerically, the step halved until it helps). That sum grows without bound as a corner flattens, so no cell can be inverted, and a step is taken only
        // if the worst corner round the node does not get worse - so the worst cell of the mesh never gets worse and the sum (BarrierSum) only goes down; the mean scaled Jacobian is not guaranteed, and may fall a little while the worst cells rise.
        for (int pass = 0; pass < options.OptimizationPasses; pass++)
        {
            long biggest = 0;                                                              // the biggest move of the pass, in millionths of a coarse cell
            Sweep(i =>
            {
                if (Worst(cellsOf[i], cells, pos) >= GoodEnough) return false;           // all the cells round it are fine already: leave it
                double d = OptimizeNode(i, Free(i), cellsOf[i], cells, neighbours[i], pos);
                long micro = (long)(d * 1e6);
                long seen;
                while (micro > (seen = Interlocked.Read(ref biggest)) && Interlocked.CompareExchange(ref biggest, micro, seen) != seen) { }
                return d > 0;
            });
            onPass?.Invoke(options.Iterations + pass + 1, pos);
            if (biggest < 100 || cancel.IsCancellationRequested) break;                  // nothing moves by more than a ten-thousandth of a coarse cell any more
        }

        int moved = 0;
        for (int i = 0; i < mesh.Nodes.Count; i++)
            if (Math.Abs(pos[i * 3] - lattice[i * 3]) + Math.Abs(pos[i * 3 + 1] - lattice[i * 3 + 1]) + Math.Abs(pos[i * 3 + 2] - lattice[i * 3 + 2]) > 1e-12) moved++;
        return new SmoothingResult(pos, before, QualityOf(mesh, pos), moved);
    }

    // groups the nodes that can move together: no two nodes of a group lie in the same cell (greedy colouring in the order of the nodes, so it is the same every time)
    private static int[][] Classes(int count, int[][] cells, List<int>[] cellsOf, Func<int, bool> take)
    {
        var color = new int[count];
        Array.Fill(color, -1);
        var groups = new List<List<int>>();
        var used = new HashSet<int>();
        for (int i = 0; i < count; i++)
        {
            if (!take(i)) continue;
            used.Clear();
            foreach (int c in cellsOf[i]) foreach (int n in cells[c]) if (color[n] >= 0) used.Add(color[n]);
            int k = 0;
            while (used.Contains(k)) k++;
            color[i] = k;
            if (k == groups.Count) groups.Add(new List<int>());
            groups[k].Add(i);
        }
        return groups.Select(g => g.ToArray()).ToArray();
    }

    /// <summary>The quantity the optimization smooths down: over all the corners of all the cells, the sum of (1/s - 1)^2 with s the scaled Jacobian (0 for a mesh of boxes).</summary>
    public static double BarrierSum(HexMesh mesh, double[] pos)
    {
        double sum = 0;
        Span<double> corners = stackalloc double[8];
        foreach (var cell in mesh.Cells.Values)
        {
            CornerValues(cell.Nodes, pos, corners);
            for (int k = 0; k < 8; k++) sum += Barrier(corners[k]);
        }
        return sum;
    }

    // the barrier of a corner: 0 for a box, growing without bound as the corner flattens, infinite when it is inverted
    private static double Barrier(double s) => s <= 1e-9 ? double.PositiveInfinity : (1 / s - 1) * (1 / s - 1);

    // the sum of the barriers over the corners that depend on the node (its own corner in every cell and the three corners next to it), and the smallest
    // scaled Jacobian among them; the other four corners of each cell do not change when the node moves
    private static (double Sum, double Worst) Objective(int node, List<int> cellIds, int[][] cells, double[] pos)
    {
        double sum = 0, worst = double.MaxValue;
        foreach (int c in cellIds)
        {
            int slot = Array.IndexOf(cells[c], node);
            for (int k = 0; k < 4; k++)
            {
                double s = CornerValue(cells[c], pos, k == 0 ? slot : slot ^ (1 << (k - 1)));
                sum += Barrier(s);
                worst = Math.Min(worst, s);
            }
        }
        return (sum, worst);
    }

    // a node whose worst cell is better than this is not moved by the optimization
    private const double GoodEnough = 0.9;

    private static double Worst(List<int> cellIds, int[][] cells, double[] pos) => Local(cellIds, cells, pos).Worst;

    // moves one node to a place where the cells round it are better; returns how far it moved (in coarse cells), 0 if it stayed
    private static double OptimizeNode(int node, int free, List<int> cellIds, int[][] cells, int[] neighbours, double[] pos)
    {
        double scale = 0;
        foreach (int j in neighbours)
            scale += Math.Sqrt(Math.Pow(pos[j * 3] - pos[node * 3], 2) + Math.Pow(pos[j * 3 + 1] - pos[node * 3 + 1], 2) + Math.Pow(pos[j * 3 + 2] - pos[node * 3 + 2], 2));
        scale /= neighbours.Length;
        if (scale < 1e-12) return 0;
        double x00 = pos[node * 3], y00 = pos[node * 3 + 1], z00 = pos[node * 3 + 2];
        double Moved() => Math.Abs(pos[node * 3] - x00) + Math.Abs(pos[node * 3 + 1] - y00) + Math.Abs(pos[node * 3 + 2] - z00);
        Span<double> grad = stackalloc double[3];
        for (int step = 0; step < 12; step++)
        {
            var (f0, worst0) = Objective(node, cellIds, cells, pos);
            if (double.IsInfinity(f0) || f0 < 1e-9) return Moved();
            double h = 1e-5 * scale, norm = 0;
            for (int a = 0; a < 3; a++)
            {
                grad[a] = 0;
                if ((free >> a & 1) == 0) continue;
                double x = pos[node * 3 + a];
                pos[node * 3 + a] = x + h; double fp = Objective(node, cellIds, cells, pos).Sum;
                pos[node * 3 + a] = x - h; double fm = Objective(node, cellIds, cells, pos).Sum;
                pos[node * 3 + a] = x;
                grad[a] = double.IsInfinity(fp) || double.IsInfinity(fm) ? 0 : (fp - fm) / (2 * h);
                norm += grad[a] * grad[a];
            }
            norm = Math.Sqrt(norm);
            if (norm < 1e-12) return Moved();
            double x0 = pos[node * 3], y0 = pos[node * 3 + 1], z0 = pos[node * 3 + 2];
            double t = 0.3 * scale;
            bool accepted = false;
            for (int attempt = 0; attempt < 10 && !accepted; attempt++, t *= 0.5)
            {
                pos[node * 3] = x0 - t * grad[0] / norm; pos[node * 3 + 1] = y0 - t * grad[1] / norm; pos[node * 3 + 2] = z0 - t * grad[2] / norm;
                var (f1, worst1) = Objective(node, cellIds, cells, pos);
                accepted = f1 < f0 - 1e-12 * Math.Max(1, f0) && worst1 >= worst0 - 1e-12;
            }
            if (!accepted) { pos[node * 3] = x0; pos[node * 3 + 1] = y0; pos[node * 3 + 2] = z0; return Moved(); }
        }
        return Moved();
    }

    // the scaled Jacobian at one corner of a cell
    private static double CornerValue(int[] nodes, double[] pos, int s)
    {
        Span<double> e = stackalloc double[9];
        for (int axis = 0; axis < 3; axis++)
        {
            int a = nodes[s], b = nodes[s ^ (1 << axis)];
            double sign = Hex.Bit(s, axis) == 0 ? 1 : -1;
            for (int k = 0; k < 3; k++) e[axis * 3 + k] = sign * (pos[b * 3 + k] - pos[a * 3 + k]);
        }
        double det = e[0] * (e[4] * e[8] - e[5] * e[7]) - e[1] * (e[3] * e[8] - e[5] * e[6]) + e[2] * (e[3] * e[7] - e[4] * e[6]);
        double n = Math.Sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]) * Math.Sqrt(e[3] * e[3] + e[4] * e[4] + e[5] * e[5]) * Math.Sqrt(e[6] * e[6] + e[7] * e[7] + e[8] * e[8]);
        return n < 1e-300 ? -1 : det / n;
    }

    // the scaled Jacobian at each of the eight corners of a cell (in the order of the slots)
    private static void CornerValues(int[] nodes, double[] pos, Span<double> result)
    {
        Span<double> e = stackalloc double[9];
        for (int s = 0; s < 8; s++)
        {
            for (int axis = 0; axis < 3; axis++)
            {
                int a = nodes[s], b = nodes[s ^ (1 << axis)];
                double sign = Hex.Bit(s, axis) == 0 ? 1 : -1;
                for (int k = 0; k < 3; k++) e[axis * 3 + k] = sign * (pos[b * 3 + k] - pos[a * 3 + k]);
            }
            double det = e[0] * (e[4] * e[8] - e[5] * e[7]) - e[1] * (e[3] * e[8] - e[5] * e[6]) + e[2] * (e[3] * e[7] - e[4] * e[6]);
            double n = Math.Sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]) * Math.Sqrt(e[3] * e[3] + e[4] * e[4] + e[5] * e[5]) * Math.Sqrt(e[6] * e[6] + e[7] * e[7] + e[8] * e[8]);
            result[s] = n < 1e-300 ? -1 : det / n;
        }
    }

    // the worst scaled Jacobian of the given cells, and the sum of them
    private static (double Worst, double Total) Local(List<int> cellIds, int[][] cells, double[] pos)
    {
        double worst = double.MaxValue, total = 0;
        foreach (int c in cellIds)
        {
            double q = ScaledJacobian(cells[c], pos);
            worst = Math.Min(worst, q);
            total += q;
        }
        return (worst, total);
    }

    /// <summary>The scaled Jacobian of a cell: the smallest, over the eight corners, of det / (|a| |b| |c|) of the edges at the corner.</summary>
    public static double ScaledJacobian(int[] nodes, double[] pos)
    {
        double min = double.MaxValue;
        Span<double> e = stackalloc double[9];
        for (int s = 0; s < 8; s++)
        {
            for (int axis = 0; axis < 3; axis++)
            {
                int a = nodes[s], b = nodes[s ^ (1 << axis)];
                double sign = Hex.Bit(s, axis) == 0 ? 1 : -1;
                for (int k = 0; k < 3; k++) e[axis * 3 + k] = sign * (pos[b * 3 + k] - pos[a * 3 + k]);
            }
            double det = e[0] * (e[4] * e[8] - e[5] * e[7]) - e[1] * (e[3] * e[8] - e[5] * e[6]) + e[2] * (e[3] * e[7] - e[4] * e[6]);
            double n = Math.Sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]) * Math.Sqrt(e[3] * e[3] + e[4] * e[4] + e[5] * e[5]) * Math.Sqrt(e[6] * e[6] + e[7] * e[7] + e[8] * e[8]);
            min = Math.Min(min, n < 1e-300 ? -1 : det / n);
        }
        return min;
    }

    private static int[][] Neighbours(HexMesh mesh)
    {
        var sets = new HashSet<int>[mesh.Nodes.Count];
        for (int i = 0; i < sets.Length; i++) sets[i] = new HashSet<int>();
        foreach (var cell in mesh.Cells.Values)
            for (int s = 0; s < 8; s++)
                for (int axis = 0; axis < 3; axis++)
                    if (Hex.Bit(s, axis) == 0)
                    {
                        int a = cell.Nodes[s], b = cell.Nodes[s | 1 << axis];
                        sets[a].Add(b);
                        sets[b].Add(a);
                    }
        return sets.Select(s => s.OrderBy(x => x).ToArray()).ToArray();
    }

    // ---- quality -------------------------------------------------------------------------------------------------------

    // the determinant of the Jacobian of the trilinear map at (u, v, w) in [0, 1]^3
    private static double Det(int[] nodes, double[] pos, double u, double v, double w)
    {
        double[] du = new double[3], dv = new double[3], dw = new double[3];
        for (int s = 0; s < 8; s++)
        {
            int a = Hex.Bit(s, 0), b = Hex.Bit(s, 1), c = Hex.Bit(s, 2);
            double fu = a == 1 ? u : 1 - u, fv = b == 1 ? v : 1 - v, fw = c == 1 ? w : 1 - w;
            double gu = a == 1 ? 1 : -1, gv = b == 1 ? 1 : -1, gw = c == 1 ? 1 : -1;
            for (int k = 0; k < 3; k++)
            {
                double x = pos[nodes[s] * 3 + k];
                du[k] += gu * fv * fw * x;
                dv[k] += fu * gv * fw * x;
                dw[k] += fu * fv * gw * x;
            }
        }
        return du[0] * (dv[1] * dw[2] - dv[2] * dw[1]) - du[1] * (dv[0] * dw[2] - dv[2] * dw[0]) + du[2] * (dv[0] * dw[1] - dv[1] * dw[0]);
    }

    // the corners and the middle: enough to see that a cell has been turned inside out
    private static bool IsValid(int[] nodes, double[] pos)
    {
        for (int s = 0; s < 8; s++)
            if (Det(nodes, pos, Hex.Bit(s, 0), Hex.Bit(s, 1), Hex.Bit(s, 2)) <= 0) return false;
        return Det(nodes, pos, 0.5, 0.5, 0.5) > 0;
    }

    private static readonly double[] Gauss = { 0.5 - Math.Sqrt(0.15), 0.5, 0.5 + Math.Sqrt(0.15) };

    /// <summary>Q of one cell: the smallest determinant of the Jacobian over the largest, at 27 Gauss points; 1 for a parallelepiped, 0 or less when inverted.</summary>
    public static double CellQuality(Cell cell, double[] pos)
    {
        double min = double.MaxValue, max = double.MinValue;
        foreach (double u in Gauss) foreach (double v in Gauss) foreach (double w in Gauss)
        {
            double d = Det(cell.Nodes, pos, u, v, w);
            min = Math.Min(min, d);
            max = Math.Max(max, d);
        }
        return max <= 0 ? min / Math.Max(Math.Abs(min), 1e-300) : min / max;
    }

    public static Quality QualityOf(HexMesh mesh, double[] pos)
    {
        double min = double.MaxValue, sum = 0, minScaled = double.MaxValue, sumScaled = 0;
        int poor = 0, inverted = 0;
        foreach (var cell in mesh.Cells.Values)
        {
            double q = CellQuality(cell, pos), scaled = ScaledJacobian(cell.Nodes, pos);
            min = Math.Min(min, q);
            sum += q;
            minScaled = Math.Min(minScaled, scaled);
            sumScaled += scaled;
            if (scaled < 0.3) poor++;
            if (q <= 0 || scaled <= 0) inverted++;
        }
        int n = mesh.Cells.Count;
        return n == 0 ? new Quality(1, 1, 0, 0, 0, 1, 1) : new Quality(min, sum / n, poor, inverted, n, minScaled, sumScaled / n);
    }

    /// <summary>The volume of all the cells (in units of coarse cells).</summary>
    public static double TotalVolume(HexMesh mesh, double[] pos)
    {
        double total = 0;
        double g = 0.5 / Math.Sqrt(3.0);
        foreach (var cell in mesh.Cells.Values)
            foreach (int ix in new[] { 0, 1 }) foreach (int iy in new[] { 0, 1 }) foreach (int iz in new[] { 0, 1 })
                total += Det(cell.Nodes, pos, 0.5 + (ix == 0 ? -g : g), 0.5 + (iy == 0 ? -g : g), 0.5 + (iz == 0 ? -g : g)) / 8.0;
        return total;
    }
}
