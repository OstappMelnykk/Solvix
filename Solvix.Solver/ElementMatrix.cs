using FemSolver;

namespace Solvix.Solver;

/// <summary>
/// The stiffness matrix of one 20-node element, with the gradient of the shape functions taken the right way round.
///
/// The solver project's own <c>ElementStiffness.Compute</c> builds J[m, n] = d x_m / d xi_n and then uses
/// dN/dx_m = sum_n Jinv[m, n] dN/d xi_n, i.e. J^-1 where the chain rule needs J^-T
/// (dN/dx_m = sum_n Jinv[n, m] dN/d xi_n). The two agree only when J is symmetric - a box, whose J is diagonal -
/// so a straight bar is solved correctly, but any element that is skewed, bent or round is not: a constant strain
/// is no longer reproduced (the patch test fails by orders of magnitude). This is the same computation with the
/// transposed product; for a box it is identical, for anything else it is the correct one.
/// </summary>
internal static class ElementMatrix
{
    private const int Nodes = 20;

    /// <summary>Gradient of every shape function at a point where the local derivatives are <paramref name="local"/> (dN/da, dN/db, dN/dg per node).</summary>
    public static double Gradient(double[,] jacobianInverse, double da, double db, double dg, int row) =>
        jacobianInverse[0, row] * da + jacobianInverse[1, row] * db + jacobianInverse[2, row] * dg;

    public static void Stiffness(int e, FemMesh mesh, double lambda, double mu, double[,,] dfiabg, double[,] ke)
    {
        Array.Clear(ke);
        var xg = new double[Nodes];
        var yg = new double[Nodes];
        var zg = new double[Nodes];
        for (int i = 0; i < Nodes; i++)
        {
            int node = mesh.Connectivity[e, i];
            xg[i] = mesh.Positions[node, 0];
            yg[i] = mesh.Positions[node, 1];
            zg[i] = mesh.Positions[node, 2];
        }

        var jacobian = new double[3, 3];
        var inverse = new double[3, 3];
        var px = new double[Nodes];
        var py = new double[Nodes];
        var pz = new double[Nodes];
        var weights = ShapeFunctions.GaussWeights;
        double lame = (lambda - 2.0 * mu) / 2.0;       // the solver's convention: lambda is E / ((1 + nu)(1 - 2 nu))
        double diagonal = lame + 2.0 * mu, off = lame;

        for (int k1 = 0; k1 < 3; k1++)
            for (int k2 = 0; k2 < 3; k2++)
                for (int k3 = 0; k3 < 3; k3++)
                {
                    int gp = k1 * 9 + k2 * 3 + k3;
                    double w = weights[k1] * weights[k2] * weights[k3];
                    Array.Clear(jacobian);
                    for (int i = 0; i < Nodes; i++)
                    {
                        double da = dfiabg[gp, 0, i], db = dfiabg[gp, 1, i], dg = dfiabg[gp, 2, i];
                        jacobian[0, 0] += da * xg[i]; jacobian[0, 1] += db * xg[i]; jacobian[0, 2] += dg * xg[i];
                        jacobian[1, 0] += da * yg[i]; jacobian[1, 1] += db * yg[i]; jacobian[1, 2] += dg * yg[i];
                        jacobian[2, 0] += da * zg[i]; jacobian[2, 1] += db * zg[i]; jacobian[2, 2] += dg * zg[i];
                    }
                    double det = ElementStiffness.ComputeDetAndInverse3x3(jacobian, inverse);
                    if (Math.Abs(det) < 1e-14) throw new InvalidOperationException($"Element {e}, Gauss point {gp}: degenerate Jacobian det={det}");
                    for (int i = 0; i < Nodes; i++)
                    {
                        double da = dfiabg[gp, 0, i], db = dfiabg[gp, 1, i], dg = dfiabg[gp, 2, i];
                        px[i] = Gradient(inverse, da, db, dg, 0);
                        py[i] = Gradient(inverse, da, db, dg, 1);
                        pz[i] = Gradient(inverse, da, db, dg, 2);
                    }
                    double wd = w * det;
                    for (int i = 0; i < Nodes; i++)
                        for (int j = 0; j < Nodes; j++)
                        {
                            ke[i, j] += wd * (diagonal * px[i] * px[j] + mu * (py[i] * py[j] + pz[i] * pz[j]));
                            ke[20 + i, 20 + j] += wd * (diagonal * py[i] * py[j] + mu * (px[i] * px[j] + pz[i] * pz[j]));
                            ke[40 + i, 40 + j] += wd * (diagonal * pz[i] * pz[j] + mu * (px[i] * px[j] + py[i] * py[j]));
                            ke[i, 20 + j] += wd * (off * px[i] * py[j] + mu * py[i] * px[j]);
                            ke[i, 40 + j] += wd * (off * px[i] * pz[j] + mu * pz[i] * px[j]);
                            ke[20 + i, 40 + j] += wd * (off * py[i] * pz[j] + mu * pz[i] * py[j]);
                        }
                }
        for (int i = 0; i < Nodes; i++)
            for (int j = 0; j < Nodes; j++)
            {
                ke[20 + j, i] = ke[i, 20 + j];
                ke[40 + j, i] = ke[i, 40 + j];
                ke[40 + j, 20 + i] = ke[20 + i, 40 + j];
            }
    }
}
