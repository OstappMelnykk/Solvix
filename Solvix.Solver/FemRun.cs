using FemSolver;
using Solvix.Contracts.Facades;

namespace Solvix.Solver;

/// <summary>
/// One linear static solve over a mesh whose cubes may have different materials. The element physics (stiffness,
/// face pressure, clamped faces) is the FEM solver's own; what differs from <c>FemSolverCore</c> is that the
/// stiffness and the stress use each element's own Lamé constants, and the sparse system is solved here
/// (a preconditioned conjugate gradient with progress and cancellation).
/// </summary>
internal static class FemRun
{
    public sealed record Input(
        FemMesh Mesh,
        double[] Lambda,
        double[] Mu,
        HashSet<long> FixedFaces,
        IReadOnlyList<(HashSet<long> Faces, double Pn)> Loads);

    public sealed record Output(double[] Displacements, double[,] Stress, double[] VonMises, int Iterations, double Residual, bool Converged);

    public static Output Solve(Input input, Action<double, string> progress, CancellationToken cancel)
    {
        var mesh = input.Mesh;
        int nodes = mesh.NodeCount, elements = mesh.ElementCount, dofs = 3 * nodes;

        progress(0, "Структура матриці");
        var (rowPtr, colIdx) = Pattern(mesh);
        var values = new double[colIdx.Length];

        var dfiabg = ShapeFunctions.PrecomputeVolumeDerivatives();
        var ke = new double[60, 60];
        var edofs = new int[60];
        for (int e = 0; e < elements; e++)
        {
            cancel.ThrowIfCancellationRequested();
            ElementStiffness.Compute(e, mesh, input.Lambda[e], input.Mu[e], dfiabg, ke);
            for (int i = 0; i < 20; i++)
            {
                int node = mesh.Connectivity[e, i];
                edofs[i] = node; edofs[20 + i] = nodes + node; edofs[40 + i] = 2 * nodes + node;
            }
            for (int a = 0; a < 60; a++)
            {
                int row = edofs[a], start = rowPtr[row], end = rowPtr[row + 1] - 1;
                for (int b = 0; b < 60; b++)
                {
                    double v = ke[a, b];
                    if (v != 0.0) values[Find(colIdx, start, end, edofs[b])] += v;
                }
            }
            if (e % 50 == 0) progress(0.05 + 0.4 * e / elements, "Збирання матриці жорсткості");
        }

        progress(0.45, "Навантаження та закріплення");
        var load = new double[dofs];
        var dpsite = ShapeFunctions.PrecomputeSurfaceDerivatives();
        foreach (var (faces, pn) in input.Loads)
        {
            var part = LoadAssembler.AssemblePressure(mesh, pn, dpsite, faces);
            for (int i = 0; i < dofs; i++) load[i] += part[i];
        }
        var fixedDofs = new HashSet<int>(BoundaryConditions.GetFixedDOFsFromFaceSet(mesh, input.FixedFaces));
        for (int i = 0; i < dofs; i++)
        {
            bool rowFixed = fixedDofs.Contains(i);
            for (int k = rowPtr[i]; k < rowPtr[i + 1]; k++)
            {
                if (rowFixed || fixedDofs.Contains(colIdx[k])) values[k] = rowFixed && colIdx[k] == i ? 1.0 : 0.0;
            }
            if (rowFixed) load[i] = 0.0;
        }

        var u = new double[dofs];
        var (iterations, residual, converged) = ConjugateGradient(rowPtr, colIdx, values, load, u,
            fraction => progress(0.5 + 0.4 * fraction, "Розв'язання системи"), cancel);

        progress(0.9, "Напруження");
        var (stress, vonMises) = Stresses(input, u, cancel);
        progress(1, "Готово");
        return new Output(u, stress, vonMises, iterations, residual, converged);
    }

    // ---- sparse pattern -----------------------------------------------------------------

    private static (int[] RowPtr, int[] ColIdx) Pattern(FemMesh mesh)
    {
        int nodes = mesh.NodeCount;
        var neighbours = new SortedSet<int>[nodes];
        for (int n = 0; n < nodes; n++) neighbours[n] = new SortedSet<int>();
        for (int e = 0; e < mesh.ElementCount; e++)
            for (int i = 0; i < 20; i++)
                for (int j = 0; j < 20; j++)
                    neighbours[mesh.Connectivity[e, i]].Add(mesh.Connectivity[e, j]);

        var rowPtr = new int[3 * nodes + 1];
        for (int c = 0; c < 3; c++)
            for (int n = 0; n < nodes; n++)
            {
                int row = c * nodes + n;
                rowPtr[row + 1] = rowPtr[row] + 3 * neighbours[n].Count;
            }
        var colIdx = new int[rowPtr[3 * nodes]];
        for (int c = 0; c < 3; c++)
            for (int n = 0; n < nodes; n++)
            {
                int k = rowPtr[c * nodes + n];
                for (int cc = 0; cc < 3; cc++)
                    foreach (int m in neighbours[n]) colIdx[k++] = cc * nodes + m;
            }
        return (rowPtr, colIdx);
    }

    private static int Find(int[] sorted, int lo, int hi, int target)
    {
        while (lo <= hi)
        {
            int mid = (lo + hi) >> 1;
            if (sorted[mid] == target) return mid;
            if (sorted[mid] < target) lo = mid + 1; else hi = mid - 1;
        }
        throw new InvalidOperationException("A column is missing from the sparse pattern.");
    }

    // ---- conjugate gradient --------------------------------------------------------------

    private static (int Iterations, double Residual, bool Converged) ConjugateGradient(
        int[] rowPtr, int[] colIdx, double[] values, double[] b, double[] x, Action<double> progress, CancellationToken cancel)
    {
        int n = b.Length;
        const double tolerance = 1e-10;
        int maxIterations = Math.Max(3 * n, 10_000);
        var inverseDiagonal = new double[n];
        for (int i = 0; i < n; i++)
        {
            double d = 0;
            for (int k = rowPtr[i]; k < rowPtr[i + 1]; k++) if (colIdx[k] == i) d = values[k];
            inverseDiagonal[i] = Math.Abs(d) > 1e-30 ? 1.0 / d : 1.0;
        }
        double bNorm = Math.Sqrt(b.Sum(v => v * v));
        if (bNorm < 1e-300) return (0, 0, true);                         // nothing pushes: the solution is zero

        var r = (double[])b.Clone();
        var z = new double[n];
        var p = new double[n];
        var ap = new double[n];
        for (int i = 0; i < n; i++) { z[i] = inverseDiagonal[i] * r[i]; p[i] = z[i]; }
        double rz = Dot(r, z);
        double relative = 1;
        for (int iteration = 0; iteration < maxIterations; iteration++)
        {
            for (int i = 0; i < n; i++)
            {
                double s = 0;
                for (int k = rowPtr[i]; k < rowPtr[i + 1]; k++) s += values[k] * p[colIdx[k]];
                ap[i] = s;
            }
            double pAp = Dot(p, ap);
            if (Math.Abs(pAp) < 1e-300) return (iteration, relative, false);
            double alpha = rz / pAp, rr = 0;
            for (int i = 0; i < n; i++)
            {
                x[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
                rr += r[i] * r[i];
            }
            relative = Math.Sqrt(rr) / bNorm;
            if (iteration % 25 == 0)
            {
                cancel.ThrowIfCancellationRequested();
                progress(Math.Clamp(Math.Log10(1 / Math.Max(relative, 1e-300)) / -Math.Log10(tolerance), 0, 1));
            }
            if (relative < tolerance) return (iteration + 1, relative, true);
            for (int i = 0; i < n; i++) z[i] = inverseDiagonal[i] * r[i];
            double rzNew = Dot(r, z), beta = rzNew / rz;
            rz = rzNew;
            for (int i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
        }
        return (maxIterations, relative, false);
    }

    private static double Dot(double[] a, double[] b)
    {
        double s = 0;
        for (int i = 0; i < a.Length; i++) s += a[i] * b[i];
        return s;
    }

    private static readonly double NearestGauss = Math.Sqrt(0.6);

    // ---- stress --------------------------------------------------------------------------

    // Hooke's law at each element's nodes with the element's own constants, averaged over the elements that
    // share a node (across a material interface the value is a blend). The strain is sampled not exactly at the
    // node but at the Gauss point nearest to it (the node's local coordinates scaled by sqrt(3/5)): at a corner
    // of a curved, barely-valid cube the Jacobian is almost singular and the strain there is meaningless, while
    // at the Gauss point - where the stiffness is integrated - it is well defined. For a smooth field the two
    // agree to the order of the element size.
    private static (double[,] Stress, double[] VonMises) Stresses(Input input, double[] u, CancellationToken cancel)
    {
        var mesh = input.Mesh;
        int nodes = mesh.NodeCount;
        var sum = new double[nodes, 6];
        var count = new int[nodes];
        var dPhi = new double[20, 3];
        var jac = new double[3, 3];
        var inverse = new double[3, 3];
        var dXyz = new double[20, 3];
        var xg = new double[20]; var yg = new double[20]; var zg = new double[20];
        var ux = new double[20]; var uy = new double[20]; var uz = new double[20];

        for (int e = 0; e < mesh.ElementCount; e++)
        {
            cancel.ThrowIfCancellationRequested();
            double lame = (input.Lambda[e] - 2.0 * input.Mu[e]) / 2.0, mu = input.Mu[e];
            double diagonal = lame + 2.0 * mu, off = lame;
            for (int i = 0; i < 20; i++)
            {
                int g = mesh.Connectivity[e, i];
                xg[i] = mesh.Positions[g, 0]; yg[i] = mesh.Positions[g, 1]; zg[i] = mesh.Positions[g, 2];
                ux[i] = u[g]; uy[i] = u[nodes + g]; uz[i] = u[2 * nodes + g];
            }
            for (int k = 0; k < 20; k++)
            {
                ShapeFunctions.EvalShapeDerivativesLocal(NearestGauss * ShapeFunctions.LocalCoords[k, 0], NearestGauss * ShapeFunctions.LocalCoords[k, 1], NearestGauss * ShapeFunctions.LocalCoords[k, 2], dPhi);
                Array.Clear(jac);
                for (int i = 0; i < 20; i++)
                    for (int c = 0; c < 3; c++)
                    {
                        jac[0, c] += dPhi[i, c] * xg[i];
                        jac[1, c] += dPhi[i, c] * yg[i];
                        jac[2, c] += dPhi[i, c] * zg[i];
                    }
                if (Math.Abs(ElementStiffness.ComputeDetAndInverse3x3(jac, inverse)) < 1e-30) continue;
                double dxx = 0, dxy = 0, dxz = 0, dyx = 0, dyy = 0, dyz = 0, dzx = 0, dzy = 0, dzz = 0;
                for (int i = 0; i < 20; i++)
                {
                    double gx = inverse[0, 0] * dPhi[i, 0] + inverse[0, 1] * dPhi[i, 1] + inverse[0, 2] * dPhi[i, 2];
                    double gy = inverse[1, 0] * dPhi[i, 0] + inverse[1, 1] * dPhi[i, 1] + inverse[1, 2] * dPhi[i, 2];
                    double gz = inverse[2, 0] * dPhi[i, 0] + inverse[2, 1] * dPhi[i, 1] + inverse[2, 2] * dPhi[i, 2];
                    dxx += ux[i] * gx; dxy += ux[i] * gy; dxz += ux[i] * gz;
                    dyx += uy[i] * gx; dyy += uy[i] * gy; dyz += uy[i] * gz;
                    dzx += uz[i] * gx; dzy += uz[i] * gy; dzz += uz[i] * gz;
                }
                int node = mesh.Connectivity[e, k];
                sum[node, 0] += diagonal * dxx + off * (dyy + dzz);
                sum[node, 1] += diagonal * dyy + off * (dxx + dzz);
                sum[node, 2] += diagonal * dzz + off * (dxx + dyy);
                sum[node, 3] += mu * (dxy + dyx);
                sum[node, 4] += mu * (dyz + dzy);
                sum[node, 5] += mu * (dxz + dzx);
                count[node]++;
            }
        }
        var stress = new double[nodes, 6];
        var vonMises = new double[nodes];
        for (int n = 0; n < nodes; n++)
        {
            if (count[n] == 0) continue;
            for (int c = 0; c < 6; c++) stress[n, c] = sum[n, c] / count[n];
            double sxx = stress[n, 0], syy = stress[n, 1], szz = stress[n, 2], sxy = stress[n, 3], syz = stress[n, 4], sxz = stress[n, 5];
            vonMises[n] = Math.Sqrt(0.5 * ((sxx - syy) * (sxx - syy) + (syy - szz) * (syy - szz) + (szz - sxx) * (szz - sxx) + 6 * (sxy * sxy + syz * syz + sxz * sxz)));
        }
        return (stress, vonMises);
    }
}
