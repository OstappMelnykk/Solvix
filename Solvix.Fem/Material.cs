namespace Solvix.Fem;

/// <summary>
/// A linear elastic material, as its 6x6 constitutive matrix D in Voigt order (xx, yy, zz, xy, yz, xz) with
/// engineering shear strains: sigma = D * epsilon. Isotropic materials are built from E and nu; an anisotropic one
/// (enamel and dentin are not isotropic) only needs another way of filling D - the element code is the same.
/// </summary>
public sealed class Material
{
    public Material(double[,] d, string name = "")
    {
        if (d.GetLength(0) != 6 || d.GetLength(1) != 6) throw new ArgumentException("D must be 6x6.");
        D = d;
        Name = name;
    }

    public string Name { get; }
    public double[,] D { get; }

    /// <summary>Isotropic: lambda = E nu / ((1 + nu)(1 - 2 nu)) - the first Lame constant - and mu = E / (2 (1 + nu)).</summary>
    public static Material Isotropic(double e, double nu, string name = "")
    {
        if (!double.IsFinite(e) || e <= 0) throw new ArgumentException("Young's modulus must be positive.");
        if (!double.IsFinite(nu) || nu < 0 || nu >= 0.5) throw new ArgumentException("Poisson's ratio must be in [0, 0.5).");
        double lambda = e * nu / ((1 + nu) * (1 - 2 * nu)), mu = e / (2 * (1 + nu));
        var d = new double[6, 6];
        for (int i = 0; i < 3; i++)
        {
            for (int j = 0; j < 3; j++) d[i, j] = lambda;
            d[i, i] = lambda + 2 * mu;
            d[3 + i, 3 + i] = mu;
        }
        return new Material(d, name);
    }

    /// <summary>
    /// Transversely isotropic about axis z (fibres, enamel prisms, dentin tubules): E_p and nu_p in the plane,
    /// E_z and nu_zp along the axis, G_z the shear along it. Must be rotated into the element's frame by the caller.
    /// </summary>
    public static Material TransverselyIsotropic(double ep, double ez, double nup, double nuzp, double gz, string name = "")
    {
        var s = new double[6, 6];                                    // compliance
        double nupz = nuzp * ep / ez;
        s[0, 0] = s[1, 1] = 1 / ep;
        s[2, 2] = 1 / ez;
        s[0, 1] = s[1, 0] = -nup / ep;
        s[0, 2] = s[2, 0] = s[1, 2] = s[2, 1] = -nupz / ep;
        s[3, 3] = 2 * (1 + nup) / ep;
        s[4, 4] = s[5, 5] = 1 / gz;
        return new Material(Invert(s), name);
    }

    private static double[,] Invert(double[,] m)
    {
        int n = m.GetLength(0);
        var a = new double[n, 2 * n];
        for (int i = 0; i < n; i++) { for (int j = 0; j < n; j++) a[i, j] = m[i, j]; a[i, n + i] = 1; }
        for (int c = 0; c < n; c++)
        {
            int pivot = c;
            for (int r = c + 1; r < n; r++) if (Math.Abs(a[r, c]) > Math.Abs(a[pivot, c])) pivot = r;
            if (Math.Abs(a[pivot, c]) < 1e-300) throw new ArgumentException("The material is singular.");
            if (pivot != c) for (int j = 0; j < 2 * n; j++) (a[c, j], a[pivot, j]) = (a[pivot, j], a[c, j]);
            double p = a[c, c];
            for (int j = 0; j < 2 * n; j++) a[c, j] /= p;
            for (int r = 0; r < n; r++)
            {
                if (r == c) continue;
                double f = a[r, c];
                if (f != 0) for (int j = 0; j < 2 * n; j++) a[r, j] -= f * a[c, j];
            }
        }
        var inv = new double[n, n];
        for (int i = 0; i < n; i++) for (int j = 0; j < n; j++) inv[i, j] = a[i, n + j];
        return inv;
    }
}
