using FemSolver;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

// The patch test: a displacement field that is linear in the coordinates means a constant strain and a constant
// stress, which any valid isoparametric mesh must reproduce, so the nodal forces of the elements around an interior
// node must cancel. It is the standard way to catch an error in the element matrices.
public class PatchTests
{
    private static (FineMesh Fine, FemMesh Mesh, double[] U) BentBlock()
    {
        var editor = new HexMeshEditor();
        editor.AddBody(HexTemplates.Kind("block").Build(new Dictionary<string, double> { ["countX"] = 6, ["countY"] = 6, ["countZ"] = 6, ["length"] = 6, ["height"] = 6, ["depth"] = 6 }));
        foreach (var node in editor.Mesh.Nodes.ToList())
        {
            var p = node.Position;
            editor.MoveNode(node.Id, new Vec3(p.X + 0.15 * Math.Sin(p.Y * 1.3) + 0.1 * p.Z, p.Y + 0.12 * Math.Sin(p.X * 1.1 + p.Z), p.Z + 0.1 * Math.Sin(p.X + p.Y * 0.7)), false);
        }
        var fine = FineMesh.Build(Export(editor), 1, 1, 1);
        var mesh = new FemMesh { NodeCount = fine.NodeCount, ElementCount = fine.ElementCount, Positions = fine.Positions, Connectivity = fine.Connectivity };
        int n = fine.NodeCount;
        var u = new double[3 * n];
        for (int i = 0; i < n; i++)
        {
            double x = fine.Positions[i, 0], y = fine.Positions[i, 1], z = fine.Positions[i, 2];
            u[i] = 0.001 * x + 0.0004 * y; u[n + i] = -0.0002 * z; u[2 * n + i] = 0.0007 * x;
        }
        return (fine, mesh, u);
    }

    // largest net nodal force at a node deep inside the block, and the largest nodal force anywhere
    private static (double Interior, double Overall) Residual(Action<int, FemMesh, double[,,], double[,]> stiffness)
    {
        var (fine, mesh, u) = BentBlock();
        int n = fine.NodeCount;
        var dfiabg = ShapeFunctions.PrecomputeVolumeDerivatives();
        var f = new double[3 * n];
        var ke = new double[60, 60];
        for (int e = 0; e < fine.ElementCount; e++)
        {
            stiffness(e, mesh, dfiabg, ke);
            for (int a = 0; a < 60; a++)
            {
                double s = 0;
                for (int b = 0; b < 60; b++) s += ke[a, b] * u[(b / 20) * n + fine.Connectivity[e, b % 20]];
                f[(a / 20) * n + fine.Connectivity[e, a % 20]] += s;
            }
        }
        bool Inside(int i) => Enumerable.Range(0, 3).All(c => fine.Positions[i, c] > 1.5 && fine.Positions[i, c] < 4.5);
        double Magnitude(int i) => Math.Sqrt(f[i] * f[i] + f[n + i] * f[n + i] + f[2 * n + i] * f[2 * n + i]);
        return (Enumerable.Range(0, n).Where(Inside).Max(Magnitude), Enumerable.Range(0, n).Max(Magnitude));
    }

    [Test]
    public void The_solvers_element_matrix_reproduces_a_constant_strain_in_a_bent_mesh()
    {
        var (interior, overall) = Residual((e, mesh, dfiabg, ke) => ElementMatrix.Stiffness(e, mesh, 1e11, 8e10, dfiabg, ke));

        Assert.That(interior, Is.LessThan(overall * 1e-9), $"interior residual {interior:E2} against forces of {overall:E2}");
    }

    [Test]
    public void The_element_matrix_of_the_solver_project_does_not_on_a_bent_mesh_which_is_why_it_is_not_used()
    {
        // ElementStiffness.Compute applies J^-1 where the chain rule needs J^-T; the two agree for a box only. If the
        // solver project is ever fixed this test starts to fail - then ElementMatrix can go and Compute be used again.
        var (interior, overall) = Residual((e, mesh, dfiabg, ke) => ElementStiffness.Compute(e, mesh, 1e11, 8e10, dfiabg, ke));

        Assert.That(interior, Is.GreaterThan(overall * 0.01), $"interior residual {interior:E2} against forces of {overall:E2}");
    }

    [Test]
    public void For_a_box_the_two_agree()
    {
        var mesh = new FemMesh
        {
            NodeCount = 20,
            ElementCount = 1,
            Positions = new double[20, 3],
            Connectivity = new int[1, 20],
        };
        var fine = FineMesh.Build(Export(Bar(1)), 1, 1, 1);
        var box = new FemMesh { NodeCount = fine.NodeCount, ElementCount = 1, Positions = fine.Positions, Connectivity = fine.Connectivity };
        var dfiabg = ShapeFunctions.PrecomputeVolumeDerivatives();
        var ours = new double[60, 60];
        var theirs = new double[60, 60];

        ElementMatrix.Stiffness(0, box, 1e11, 8e10, dfiabg, ours);
        ElementStiffness.Compute(0, box, 1e11, 8e10, dfiabg, theirs);

        for (int i = 0; i < 60; i++)
            for (int j = 0; j < 60; j++) Assert.That(ours[i, j], Is.EqualTo(theirs[i, j]).Within(1e-3 + Math.Abs(theirs[i, j]) * 1e-9));
        Assert.That(mesh.NodeCount, Is.EqualTo(20));
    }

    [Test]
    public void A_skewed_single_element_keeps_the_stiffness_symmetric_and_rigid_motions_free()
    {
        var editor = Bar(1);
        editor.MoveNode(editor.Mesh.Hex(0).NodeIds[6], new Vec3(1.4, 1.3, 1.2), false);
        editor.MoveNode(editor.Mesh.Hex(0).NodeIds[1], new Vec3(1.2, 0.1, -0.1), false);
        var fine = FineMesh.Build(Export(editor), 1, 1, 1);
        var mesh = new FemMesh { NodeCount = fine.NodeCount, ElementCount = 1, Positions = fine.Positions, Connectivity = fine.Connectivity };
        var ke = new double[60, 60];

        ElementMatrix.Stiffness(0, mesh, 1e11, 8e10, ShapeFunctions.PrecomputeVolumeDerivatives(), ke);

        for (int i = 0; i < 60; i++)
            for (int j = 0; j < 60; j++) Assert.That(ke[i, j], Is.EqualTo(ke[j, i]).Within(1e-3));
        for (int axis = 0; axis < 3; axis++)
        {
            double cost = 0;
            for (int a = 0; a < 60; a++)
            {
                double s = 0;
                for (int k = 0; k < 20; k++) s += ke[a, axis * 20 + k];
                cost += Math.Abs(s);
            }
            Assert.That(cost, Is.LessThan(1e-3), $"a translation along axis {axis} must cost nothing");
        }
    }
}
