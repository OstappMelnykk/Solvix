using Solvix.FemMesh.Local;

namespace Solvix.FemMesh.Tests.Local;

public class SmokeTests
{
    [Test]
    public void A_plain_grid_is_conforming()
    {
        var mesh = LatticeMesh.Grid(3, 3, 3);
        Assert.That(Conformity.Check(mesh), Is.Empty);
        Assert.That(mesh.Cells, Has.Count.EqualTo(27));
    }

    [Test]
    public void One_cell_in_the_middle_is_split_n_by_n_by_n()
    {
        foreach (int n in new[] { 2, 3, 4 })
        {
            var mesh = LatticeMesh.Grid(5, 5, 5);
            var middle = mesh.Roots.Single(r => r.I == 2 && r.J == 2 && r.K == 2).Leaves.ToList();

            var result = Refiner.Refine(mesh, middle, n, n, n);

            var problems = Conformity.Check(mesh);
            Assert.That(problems, Is.Empty, $"n = {n}\n" + string.Join("\n", problems.Take(8)));
            Assert.That(mesh.Roots.Single(r => r.I == 2 && r.J == 2 && r.K == 2).Leaves, Has.Count.EqualTo(n * n * n), $"n = {n}");
            Assert.That(result.Passes.SelectMany(p => p.Unreached), Is.Empty);
        }
    }
}
