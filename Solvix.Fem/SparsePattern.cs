namespace Solvix.Fem;

/// <summary>The sparsity pattern (CSR) of the stiffness matrix of a mesh, and the operations on its values.</summary>
public sealed class SparsePattern
{
    private SparsePattern(int size, int[] rowPointers, int[] columns) => (Size, RowPointers, Columns) = (size, rowPointers, columns);

    public int Size { get; }
    public int[] RowPointers { get; }
    public int[] Columns { get; }

    public static SparsePattern Build(FemModel model)
    {
        int nodes = model.NodeCount;
        // node-to-node coupling: two nodes are coupled when some element holds both
        var neighbours = new HashSet<int>[nodes];
        for (int n = 0; n < nodes; n++) neighbours[n] = new HashSet<int>();
        for (int e = 0; e < model.ElementCount; e++)
            for (int i = 0; i < Hex20.Nodes; i++)
                for (int j = 0; j < Hex20.Nodes; j++) neighbours[model.Connectivity[e, i]].Add(model.Connectivity[e, j]);

        var sorted = neighbours.Select(s => s.OrderBy(x => x).ToArray()).ToArray();
        var rowPointers = new int[3 * nodes + 1];
        for (int c = 0; c < 3; c++)
            for (int n = 0; n < nodes; n++) rowPointers[c * nodes + n + 1] = rowPointers[c * nodes + n] + 3 * sorted[n].Length;
        var columns = new int[rowPointers[3 * nodes]];
        for (int c = 0; c < 3; c++)
            for (int n = 0; n < nodes; n++)
            {
                int k = rowPointers[c * nodes + n];
                for (int cc = 0; cc < 3; cc++)
                    foreach (int m in sorted[n]) columns[k++] = cc * nodes + m;
            }
        return new SparsePattern(3 * nodes, rowPointers, columns);
    }

    public int IndexOf(int row, int column)
    {
        int lo = RowPointers[row], hi = RowPointers[row + 1] - 1;
        while (lo <= hi)
        {
            int mid = (lo + hi) >> 1;
            if (Columns[mid] == column) return mid;
            if (Columns[mid] < column) lo = mid + 1; else hi = mid - 1;
        }
        throw new InvalidOperationException("A column is missing from the sparse pattern.");
    }

    public void Add(FemModel model, int element, double[,] ke, double[] values)
    {
        int nodes = model.NodeCount;
        var dofs = new int[Hex20.Dofs];
        for (int i = 0; i < Hex20.Nodes; i++)
        {
            int node = model.Connectivity[element, i];
            dofs[i] = node; dofs[20 + i] = nodes + node; dofs[40 + i] = 2 * nodes + node;
        }
        for (int a = 0; a < Hex20.Dofs; a++)
            for (int b = 0; b < Hex20.Dofs; b++) values[IndexOf(dofs[a], dofs[b])] += ke[a, b];
    }

    /// <summary>Makes the clamped dofs' rows and columns the identity and their load zero.</summary>
    public void EliminateFixed(double[] values, double[] load, HashSet<int> fixedDofs)
    {
        for (int row = 0; row < Size; row++)
        {
            bool rowFixed = fixedDofs.Contains(row);
            for (int k = RowPointers[row]; k < RowPointers[row + 1]; k++)
                if (rowFixed || fixedDofs.Contains(Columns[k])) values[k] = rowFixed && Columns[k] == row ? 1.0 : 0.0;
            if (rowFixed) load[row] = 0.0;
        }
    }

    public void Multiply(double[] values, double[] x, double[] y)
    {
        if (Size < 20000)
        {
            for (int i = 0; i < Size; i++) y[i] = Row(values, x, i);
            return;
        }
        Parallel.For(0, Size, i => y[i] = Row(values, x, i));
    }

    private double Row(double[] values, double[] x, int i)
    {
        double s = 0;
        for (int k = RowPointers[i]; k < RowPointers[i + 1]; k++) s += values[k] * x[Columns[k]];
        return s;
    }

    public double Diagonal(double[] values, int i)
    {
        for (int k = RowPointers[i]; k < RowPointers[i + 1]; k++) if (Columns[k] == i) return values[k];
        return 0;
    }
}
