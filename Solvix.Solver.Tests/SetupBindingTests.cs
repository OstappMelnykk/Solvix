using Solvix.FemMesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>What the user set up (cells of a cube and of its sides) must land on exactly the faces and elements the solver has always used.</summary>
public class SetupBindingTests
{
    private static readonly (int Cubes, int Nx, int Ny, int Nz)[] Cases =
        { (1, 1, 1, 1), (1, 3, 3, 3), (2, 2, 1, 3), (3, 2, 2, 2), (2, 8, 1, 2), (1, 5, 7, 3), (4, 1, 4, 2) };

    [TestCaseSource(nameof(Cases))]
    public void A_cell_of_a_side_is_exactly_the_one_face_the_old_arithmetic_named((int Cubes, int Nx, int Ny, int Nz) c)
    {
        var coarse = Export(Bar(c.Cubes));
        var fine = FineMesh.Build(coarse, c.Nx, c.Ny, c.Nz);
        var counts = new[] { c.Nx, c.Ny, c.Nz };

        for (int cube = 0; cube < c.Cubes; cube++)
            foreach (var side in ElementLocal.FaceNames)
            {
                int axis = side[0] - 'X';
                var tangents = Enumerable.Range(0, 3).Where(d => d != axis).ToArray();
                for (int p = 0; p < counts[tangents[0]]; p++)
                    for (int q = 0; q < counts[tangents[1]]; q++)
                    {
                        var (element, face) = fine.BoundaryElement(cube, side, p, q);
                        var bound = SetupBinding.FacesOf(fine.Mesh, cube, side, p, q, counts).ToList();
                        Assert.That(bound, Has.Count.EqualTo(1), $"cube {cube} {side} ({p},{q})");
                        Assert.That((bound[0].Element, bound[0].Face), Is.EqualTo((element, face)), $"cube {cube} {side} ({p},{q})");
                    }
            }
    }

    [TestCaseSource(nameof(Cases))]
    public void A_cell_of_a_cube_is_exactly_the_one_element_and_every_element_knows_its_cell((int Cubes, int Nx, int Ny, int Nz) c)
    {
        var coarse = Export(Bar(c.Cubes));
        var fine = FineMesh.Build(coarse, c.Nx, c.Ny, c.Nz);
        var counts = new[] { c.Nx, c.Ny, c.Nz };

        for (int e = 0; e < fine.ElementCount; e++)
        {
            var cell = new ElementKey(coarse.ElementIds[fine.ParentOf[e]], fine.Ex[e], fine.Ey[e], fine.Ez[e]);
            Assert.That(SetupBinding.CellOf(fine.Mesh, e, cell.Hex, counts), Is.EqualTo(cell), $"element {e}");
            Assert.That(SetupBinding.ElementsOf(fine.Mesh, fine.ParentOf[e], cell, counts).ToList(), Is.EqualTo(new[] { e }), $"element {e}");
        }
    }

    [TestCase(1, 1, 1, 1, 2, 2, 2)]
    [TestCase(1, 2, 2, 2, 4, 4, 4)]
    [TestCase(2, 3, 1, 2, 6, 5, 4)]
    [TestCase(1, 5, 3, 7, 2, 2, 2)]
    public void When_the_mesh_is_finer_or_coarser_than_the_setup_the_cells_tile_the_mesh_without_a_gap_or_an_overlap(int cubes, int sx, int sy, int sz, int mx, int my, int mz)
    {
        var coarse = Export(Bar(cubes));
        var mesh = new UniformRefinement(mx, my, mz).Build(coarse);
        var counts = new[] { sx, sy, sz };

        for (int cube = 0; cube < cubes; cube++)
        {
            foreach (var side in ElementLocal.FaceNames)
            {
                int axis = side[0] - 'X';
                var tangents = Enumerable.Range(0, 3).Where(d => d != axis).ToArray();
                var named = new List<Solvix.Fem.ElementFace>();
                for (int p = 0; p < counts[tangents[0]]; p++)
                    for (int q = 0; q < counts[tangents[1]]; q++) named.AddRange(SetupBinding.FacesOf(mesh, cube, side, p, q, counts));
                var all = mesh.FacesOnSide(cube, side).Select(f => new Solvix.Fem.ElementFace(f.Element, f.Face)).ToList();
                Assert.That(named.Count, Is.EqualTo(all.Count), $"cube {cube} {side}: every face in one cell");
                Assert.That(named.Distinct().Count(), Is.EqualTo(all.Count), $"cube {cube} {side}: none in two cells");
                Assert.That(named.ToHashSet().SetEquals(all), Is.True, $"cube {cube} {side}");
            }
            var elements = new List<int>();
            for (int ex = 0; ex < sx; ex++)
                for (int ey = 0; ey < sy; ey++)
                    for (int ez = 0; ez < sz; ez++) elements.AddRange(SetupBinding.ElementsOf(mesh, cube, new ElementKey(0, ex, ey, ez), counts));
            Assert.That(elements.OrderBy(i => i), Is.EqualTo(mesh.ElementsOf(cube).OrderBy(i => i)), $"cube {cube}: the elements, each in one cell");
        }
    }

    [TestCase(1, 1, 1, 1)]
    [TestCase(2, 2, 2, 2)]
    [TestCase(3, 3, 2, 1)]
    public void On_a_locally_refined_mesh_the_cells_of_the_setup_also_tile_it_without_a_gap_or_an_overlap(int cell, int sx, int sy, int sz)
    {
        var coarse = Export(Bar(4));
        var rule = new Solvix.FemMesh.Local.LocalRefinement(new[]
        {
            new Solvix.FemMesh.Local.RefinementStep(new[] { Solvix.FemMesh.Local.LocalRefinement.RootKey(1) }, 3, 3, 3),
            new Solvix.FemMesh.Local.RefinementStep(new[] { Solvix.FemMesh.Local.LocalRefinement.RootKey(2) }, 2, 2, 2, 1)
        });
        var mesh = rule.Build(coarse);
        var counts = new[] { sx, sy, sz };

        for (int cube = 0; cube < 4; cube++)
        {
            foreach (var side in ElementLocal.FaceNames)
            {
                int axis = side[0] - 'X';
                var tangents = Enumerable.Range(0, 3).Where(d => d != axis).ToArray();
                var named = new List<Solvix.Fem.ElementFace>();
                for (int p = 0; p < counts[tangents[0]]; p++)
                    for (int q = 0; q < counts[tangents[1]]; q++) named.AddRange(SetupBinding.FacesOf(mesh, cube, side, p, q, counts));
                var all = mesh.FacesOnSide(cube, side).Select(f => new Solvix.Fem.ElementFace(f.Element, f.Face)).ToList();
                Assert.That(named.Count, Is.EqualTo(all.Count), $"cube {cube} {side}: every face in one cell");
                Assert.That(named.ToHashSet().SetEquals(all), Is.True, $"cube {cube} {side}");
            }
            var elements = new List<int>();
            for (int ex = 0; ex < sx; ex++)
                for (int ey = 0; ey < sy; ey++)
                    for (int ez = 0; ez < sz; ez++) elements.AddRange(SetupBinding.ElementsOf(mesh, cube, new ElementKey(0, ex, ey, ez), counts));
            Assert.That(elements.OrderBy(i => i), Is.EqualTo(mesh.ElementsOf(cube).OrderBy(i => i)), $"cube {cube}: the elements, each in one cell");
        }
    }

    [Test]
    public void A_side_the_solver_does_not_know_names_nothing()
    {
        var mesh = new UniformRefinement(2, 2, 2).Build(Export(Bar(1)));

        Assert.That(SetupBinding.FacesOf(mesh, 0, "Nonsense", 0, 0, new[] { 2, 2, 2 }), Is.Empty);
        Assert.That(SetupBinding.ElementsOf(mesh, 99, new ElementKey(0, 0, 0, 0), new[] { 2, 2, 2 }), Is.Empty);
    }
}
