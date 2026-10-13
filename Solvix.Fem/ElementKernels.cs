namespace Solvix.Fem;

/// <summary>
/// The element-level mathematics of the isoparametric 20-node hexahedron: Jacobian, the B matrix, the stiffness
/// matrix K = integral of B^T D B, the stress at a point and the load of a pressure on a face.
///
/// Convention (the only place it matters): J[m, n] = d x_m / d xi_n, so the gradient of a shape function is
/// grad_x N = J^-T grad_xi N, i.e. dN/dx_m = sum_n Jinv[n, m] dN/d xi_n. (The solver this was ported from used J^-1
/// in that product, which is right for a box only and wrong for every skewed, bent or round element.)
/// </summary>
public static class ElementKernels
{
    /// <summary>Jacobian of the map at a point and the gradients of the 20 shape functions in global coordinates.</summary>
    public static double Gradients(double[,] xyz, double a, double b, double g, double[,] gradient, double[,]? local = null)
    {
        var d = local ?? new double[Hex20.Nodes, 3];
        Hex20.Derivatives(a, b, g, d);
        var j = new double[3, 3];
        for (int i = 0; i < Hex20.Nodes; i++)
            for (int m = 0; m < 3; m++)
                for (int n = 0; n < 3; n++) j[m, n] += d[i, n] * xyz[i, m];
        double det = j[0, 0] * (j[1, 1] * j[2, 2] - j[1, 2] * j[2, 1]) - j[0, 1] * (j[1, 0] * j[2, 2] - j[1, 2] * j[2, 0]) + j[0, 2] * (j[1, 0] * j[2, 1] - j[1, 1] * j[2, 0]);
        if (det == 0 || !double.IsFinite(det)) return det;
        double inv = 1.0 / det;
        // inverse of J, then the transposed product
        var ji = new double[3, 3];
        ji[0, 0] = (j[1, 1] * j[2, 2] - j[1, 2] * j[2, 1]) * inv; ji[0, 1] = (j[0, 2] * j[2, 1] - j[0, 1] * j[2, 2]) * inv; ji[0, 2] = (j[0, 1] * j[1, 2] - j[0, 2] * j[1, 1]) * inv;
        ji[1, 0] = (j[1, 2] * j[2, 0] - j[1, 0] * j[2, 2]) * inv; ji[1, 1] = (j[0, 0] * j[2, 2] - j[0, 2] * j[2, 0]) * inv; ji[1, 2] = (j[0, 2] * j[1, 0] - j[0, 0] * j[1, 2]) * inv;
        ji[2, 0] = (j[1, 0] * j[2, 1] - j[1, 1] * j[2, 0]) * inv; ji[2, 1] = (j[0, 1] * j[2, 0] - j[0, 0] * j[2, 1]) * inv; ji[2, 2] = (j[0, 0] * j[1, 1] - j[0, 1] * j[1, 0]) * inv;
        for (int i = 0; i < Hex20.Nodes; i++)
            for (int m = 0; m < 3; m++)
                gradient[i, m] = ji[0, m] * d[i, 0] + ji[1, m] * d[i, 1] + ji[2, m] * d[i, 2];
        return det;
    }

    /// <summary>The 6x60 strain-displacement matrix from the gradients (Voigt: xx, yy, zz, xy, yz, xz; dof order x-block, y-block, z-block).</summary>
    public static void StrainMatrix(double[,] gradient, double[,] b)
    {
        Array.Clear(b);
        for (int i = 0; i < Hex20.Nodes; i++)
        {
            double gx = gradient[i, 0], gy = gradient[i, 1], gz = gradient[i, 2];
            b[0, i] = gx;
            b[1, 20 + i] = gy;
            b[2, 40 + i] = gz;
            b[3, i] = gy; b[3, 20 + i] = gx;
            b[4, 20 + i] = gz; b[4, 40 + i] = gy;
            b[5, i] = gz; b[5, 40 + i] = gx;
        }
    }

    /// <summary>
    /// K = integral over the element of B^T D B dV with the 3x3x3 Gauss rule. Throws when the map is folded or
    /// degenerate at a Gauss point (detJ not positive) - such an element has no meaningful stiffness.
    /// </summary>
    public static void Stiffness(double[,] xyz, double[,] d, double[,] ke)
    {
        Array.Clear(ke);
        var gradient = new double[Hex20.Nodes, 3];
        var local = new double[Hex20.Nodes, 3];
        var b = new double[6, Hex20.Dofs];
        var db = new double[6, Hex20.Dofs];
        var gp = Hex20.GaussPoints;
        var gw = Hex20.GaussWeights;
        for (int i = 0; i < 3; i++)
            for (int j = 0; j < 3; j++)
                for (int k = 0; k < 3; k++)
                {
                    double det = Gradients(xyz, gp[i], gp[j], gp[k], gradient, local);
                    if (!(det > 0)) throw new InvalidOperationException($"The element is folded or degenerate (detJ = {det:E2} at Gauss point {i}{j}{k}).");
                    StrainMatrix(gradient, b);
                    double w = gw[i] * gw[j] * gw[k] * det;
                    for (int r = 0; r < 6; r++)
                        for (int c = 0; c < Hex20.Dofs; c++)
                        {
                            double s = 0;
                            for (int m = 0; m < 6; m++) s += d[r, m] * b[m, c];
                            db[r, c] = s;
                        }
                    for (int r = 0; r < Hex20.Dofs; r++)
                        for (int c = r; c < Hex20.Dofs; c++)
                        {
                            double s = 0;
                            for (int m = 0; m < 6; m++) s += b[m, r] * db[m, c];
                            ke[r, c] += w * s;
                        }
                }
        for (int r = 0; r < Hex20.Dofs; r++)
            for (int c = 0; c < r; c++) ke[r, c] = ke[c, r];
    }

    /// <summary>Stress (Voigt) at a point from the element's nodal displacements u (x-block, y-block, z-block).</summary>
    public static bool StressAt(double[,] xyz, double[,] d, double[] u, double a, double b, double g, double[] sigma)
    {
        var gradient = new double[Hex20.Nodes, 3];
        if (!(Gradients(xyz, a, b, g, gradient) > 0)) return false;
        var strain = new double[6];
        for (int i = 0; i < Hex20.Nodes; i++)
        {
            double gx = gradient[i, 0], gy = gradient[i, 1], gz = gradient[i, 2];
            double ux = u[i], uy = u[20 + i], uz = u[40 + i];
            strain[0] += gx * ux; strain[1] += gy * uy; strain[2] += gz * uz;
            strain[3] += gy * ux + gx * uy; strain[4] += gz * uy + gy * uz; strain[5] += gz * ux + gx * uz;
        }
        for (int r = 0; r < 6; r++)
        {
            double s = 0;
            for (int c = 0; c < 6; c++) s += d[r, c] * strain[c];
            sigma[r] = s;
        }
        return true;
    }

    /// <summary>
    /// Nodal load of a uniform pressure Pn on one face, along the outward normal (negative = compression):
    /// f_i = integral of Pn psi_i (dr/d eta x dr/d tau) d eta d tau, 3x3 Gauss. Returned in the element's 60 dofs.
    /// </summary>
    public static void FacePressure(double[,] xyz, int face, double pn, double[] fe)
    {
        Array.Clear(fe);
        var nodes = Hex20.FaceNodes[face];
        var psi = new double[8];
        var dpsi = new double[8, 2];
        var gp = Hex20.GaussPoints;
        var gw = Hex20.GaussWeights;
        for (int i = 0; i < 3; i++)
            for (int j = 0; j < 3; j++)
            {
                Hex20.FaceShape(gp[i], gp[j], psi);
                Hex20.FaceDerivatives(gp[i], gp[j], dpsi);
                double[] te = new double[3], tt = new double[3];
                for (int k = 0; k < 8; k++)
                    for (int c = 0; c < 3; c++)
                    {
                        te[c] += dpsi[k, 0] * xyz[nodes[k], c];
                        tt[c] += dpsi[k, 1] * xyz[nodes[k], c];
                    }
                double nx = te[1] * tt[2] - te[2] * tt[1], ny = te[2] * tt[0] - te[0] * tt[2], nz = te[0] * tt[1] - te[1] * tt[0];
                for (int k = 0; k < 8; k++)
                {
                    double f = gw[i] * gw[j] * pn * psi[k];
                    fe[nodes[k]] += f * nx;
                    fe[20 + nodes[k]] += f * ny;
                    fe[40 + nodes[k]] += f * nz;
                }
            }
    }

    /// <summary>Smallest det J over the 27 Gauss points and the 20 nodes: positive means a valid element.</summary>
    public static double MinDeterminant(double[,] xyz)
    {
        var gradient = new double[Hex20.Nodes, 3];
        double min = double.MaxValue;
        foreach (double a in Hex20.GaussPoints)
            foreach (double b in Hex20.GaussPoints)
                foreach (double g in Hex20.GaussPoints) min = Math.Min(min, Gradients(xyz, a, b, g, gradient));
        for (int n = 0; n < Hex20.Nodes; n++) min = Math.Min(min, Gradients(xyz, Hex20.Local[n, 0], Hex20.Local[n, 1], Hex20.Local[n, 2], gradient));
        return min;
    }
}
