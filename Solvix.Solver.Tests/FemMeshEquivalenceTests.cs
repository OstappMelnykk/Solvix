using Solvix.FemMesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>
/// The solver's old way of naming a face (a cube, a side and a cell (p, q) of that side) and the new one (an element and its face, from the mesh
/// abstraction <c>Solvix.FemMesh</c>) must name the same faces. While the editor still speaks of cubes and cells, this holds the two together.
/// </summary>
public class FemMeshEquivalenceTests
{
    private static readonly (int Cubes, int Nx, int Ny, int Nz)[] Cases = { (1, 1, 1, 1), (1, 3, 3, 3), (2, 2, 1, 3), (3, 2, 2, 2), (4, 1, 4, 2) };

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
