namespace Solvix.Fem;

/// <summary>Jacobi-preconditioned conjugate gradient for a symmetric positive definite system, starting from x = 0.</summary>
internal static class ConjugateGradient
{
    public static (int Iterations, double Residual, bool Converged) Solve(
        SparsePattern a, double[] values, double[] b, double[] x, Action<double> progress, CancellationToken cancel, double tolerance)
    {
        int n = b.Length;
        int maxIterations = Math.Max(3 * n, 10_000);
        var inverseDiagonal = new double[n];
        for (int i = 0; i < n; i++)
        {
            double d = a.Diagonal(values, i);
            inverseDiagonal[i] = Math.Abs(d) > 1e-30 ? 1.0 / d : 1.0;
        }
        double bNorm = Math.Sqrt(b.Sum(v => v * v));
        if (bNorm < 1e-300) return (0, 0, true);                          // nothing pushes: the solution is zero

        var r = (double[])b.Clone();
        var z = new double[n];
        var p = new double[n];
        var ap = new double[n];
        for (int i = 0; i < n; i++) { z[i] = inverseDiagonal[i] * r[i]; p[i] = z[i]; }
        double rz = Dot(r, z);
        double relative = 1;
        for (int iteration = 0; iteration < maxIterations; iteration++)
        {
            a.Multiply(values, p, ap);
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
}
