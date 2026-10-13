namespace Solvix.Fem;

/// <summary>
/// Linear static analysis: K u = f for a mesh of 20-node hexahedra, each with its own material.
///
/// 1. element stiffness matrices (in parallel) are assembled into a CSR matrix (the dof order is the three blocks
///    ux, uy, uz of NodeCount each);
/// 2. face pressures give the load vector; clamped faces are eliminated (their rows and columns become the
///    identity, which keeps the matrix symmetric positive definite);
/// 3. a Jacobi-preconditioned conjugate gradient solves the system, reporting progress and honouring cancellation;
/// 4. stress is evaluated at the Gauss point nearest each node of each element and averaged over the elements that
///    share the node.
/// </summary>
public static class LinearStaticSolver
{
    public const double Tolerance = 1e-10;

    public static FemSolution Solve(FemModel model, LoadCase loads, Action<double, string>? progress = null, CancellationToken cancel = default)
    {
        progress ??= (_, _) => { };
        int nodes = model.NodeCount, dofs = 3 * nodes;

        progress(0, "Структура матриці");
        var pattern = SparsePattern.Build(model);
        var values = new double[pattern.Columns.Length];
        Assemble(model, pattern, values, progress, cancel);

        progress(0.45, "Навантаження та закріплення");
        var load = AssembleLoad(model, loads);
        var fixedDofs = FixedDofs(model, loads.Fixed);
        pattern.EliminateFixed(values, load, fixedDofs);

        var u = new double[dofs];
        var (iterations, residual, converged) = ConjugateGradient.Solve(pattern, values, load, u, fraction => progress(0.5 + 0.4 * fraction, "Розв'язання системи"), cancel, Tolerance);

        progress(0.9, "Напруження");
        var (stress, vonMises) = RecoverStress(model, u, cancel);
        progress(1, "Готово");
        return new FemSolution(u, stress, vonMises, iterations, residual, converged);
    }

    private static void Assemble(FemModel model, SparsePattern pattern, double[] values, Action<double, string> progress, CancellationToken cancel)
    {
        const int batch = 128;
        int nodes = model.NodeCount, elements = model.ElementCount;
        for (int start = 0; start < elements; start += batch)
        {
            cancel.ThrowIfCancellationRequested();
            int count = Math.Min(batch, elements - start);
            var matrices = new double[count][,];
            Parallel.For(0, count, new ParallelOptions { CancellationToken = cancel }, i =>
            {
                int e = start + i;
                matrices[i] = new double[Hex20.Dofs, Hex20.Dofs];
                try { ElementKernels.Stiffness(model.ElementNodes(e), model.Materials[e].D, matrices[i]); }
                catch (InvalidOperationException ex) { throw new InvalidOperationException($"Element {e}: {ex.Message}", ex); }
            });
            for (int i = 0; i < count; i++) pattern.Add(model, start + i, matrices[i], values);
            progress(0.05 + 0.4 * (start + count) / elements, "Збирання матриці жорсткості");
        }
        _ = nodes;
    }

    private static double[] AssembleLoad(FemModel model, LoadCase loads)
    {
        int nodes = model.NodeCount;
        var f = new double[3 * nodes];
        var fe = new double[Hex20.Dofs];
        foreach (var (face, pn) in loads.Pressures)
        {
            ElementKernels.FacePressure(model.ElementNodes(face.Element), face.Face, pn, fe);
            for (int i = 0; i < Hex20.Nodes; i++)
            {
                int node = model.Connectivity[face.Element, i];
                f[node] += fe[i]; f[nodes + node] += fe[20 + i]; f[2 * nodes + node] += fe[40 + i];
            }
        }
        return f;
    }

    private static HashSet<int> FixedDofs(FemModel model, IReadOnlyCollection<ElementFace> faces)
    {
        int nodes = model.NodeCount;
        var set = new HashSet<int>();
        foreach (var face in faces)
            foreach (int local in Hex20.FaceNodes[face.Face])
            {
                int node = model.Connectivity[face.Element, local];
                set.Add(node); set.Add(nodes + node); set.Add(2 * nodes + node);
            }
        return set;
    }

    // The 27 Gauss points; the one nearest a node is the node's local coordinates scaled by sqrt(3/5).
    private static readonly double Near = Math.Sqrt(0.6);

    private static (double[,] Stress, double[] VonMises) RecoverStress(FemModel model, double[] u, CancellationToken cancel)
    {
        int nodes = model.NodeCount;
        var sum = new double[nodes, 6];
        var count = new int[nodes];
        var sigma = new double[6];
        for (int e = 0; e < model.ElementCount; e++)
        {
            cancel.ThrowIfCancellationRequested();
            var xyz = model.ElementNodes(e);
            var ue = model.ElementDisplacements(e, u);
            var d = model.Materials[e].D;
            for (int k = 0; k < Hex20.Nodes; k++)
            {
                if (!ElementKernels.StressAt(xyz, d, ue, Near * Hex20.Local[k, 0], Near * Hex20.Local[k, 1], Near * Hex20.Local[k, 2], sigma)) continue;
                int node = model.Connectivity[e, k];
                for (int c = 0; c < 6; c++) sum[node, c] += sigma[c];
                count[node]++;
            }
        }
        var stress = new double[nodes, 6];
        var vm = new double[nodes];
        for (int n = 0; n < nodes; n++)
        {
            if (count[n] == 0) continue;
            for (int c = 0; c < 6; c++) stress[n, c] = sum[n, c] / count[n];
            vm[n] = VonMisesStress.Of(stress[n, 0], stress[n, 1], stress[n, 2], stress[n, 3], stress[n, 4], stress[n, 5]);
        }
        return (stress, vm);
    }
}
