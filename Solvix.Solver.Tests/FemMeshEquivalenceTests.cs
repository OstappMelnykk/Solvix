using Solvix.FemMesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>
/// The new mesh abstraction (<c>Solvix.FemMesh</c>) must give exactly the mesh the solver has always worked on, so the solver can be moved onto it
/// without a single number changing. Until then both exist side by side and these tests hold them together.
/// </summary>
public class FemMeshEquivalenceTests
{
    private static readonly (int Cubes, int Nx, int Ny, int Nz)[] Cases = { (1, 1, 1, 1), (1, 3, 3, 3), (2, 2, 1, 3), (3, 2, 2, 2), (4, 1, 4, 2) };

    [TestCaseSource(nameof(Cases))]
    public void The_uniform_rule_gives_the_same_nodes_and_elements_as_the_fine_mesh((int Cubes, int Nx, int Ny, int Nz) c)
    {
        var coarse = Export(Bar(c.Cubes));

        var fine = FineMesh.Build(coarse, c.Nx, c.Ny, c.Nz);
        var mesh = new UniformRefinement(c.Nx, c.Ny, c.Nz).Build(coarse);

        Assert.That(mesh.NodeCount, Is.EqualTo(fine.NodeCount));
        Assert.That(mesh.ElementCount, Is.EqualTo(fine.ElementCount));
        for (int n = 0; n < fine.NodeCount; n++)
            for (int k = 0; k < 3; k++) Assert.That(mesh.Positions[n, k], Is.EqualTo(fine.Positions[n, k]).Within(1e-12));
        for (int e = 0; e < fine.ElementCount; e++)
        {
            for (int k = 0; k < 20; k++) Assert.That(mesh.Connectivity[e, k], Is.EqualTo(fine.Connectivity[e, k]));
            Assert.That(mesh.RootOf(e), Is.EqualTo(fine.ParentOf[e]));
        }
    }

    [TestCaseSource(nameof(Cases))]
    public void The_faces_on_a_side_of_a_cube_are_the_boundary_elements_the_solver_has_always_loaded((int Cubes, int Nx, int Ny, int Nz) c)
    {
        var coarse = Export(Bar(c.Cubes));
        var fine = FineMesh.Build(coarse, c.Nx, c.Ny, c.Nz);
        var mesh = new UniformRefinement(c.Nx, c.Ny, c.Nz).Build(coarse);

        for (int cube = 0; cube < c.Cubes; cube++)
            foreach (var side in ElementLocal.FaceNames)
            {
                var expected = fine.BoundaryElements(cube, side).Select(b => new ElementFace(b.Element, b.SolverFace)).OrderBy(f => f.Element).ToList();
                var actual = mesh.FacesOnSide(cube, side).OrderBy(f => f.Element).ToList();
                Assert.That(actual, Is.EqualTo(expected), $"cube {cube} {side}");
            }
    }
}
