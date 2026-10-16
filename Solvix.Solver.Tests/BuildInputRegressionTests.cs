using Solvix.Contracts.Facades;
using Solvix.Fem;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>
/// The solver's input (materials per element, clamped faces, pressed faces) must be exactly what the old arithmetic of the even cut produced:
/// the setup is now bound to the mesh of finite elements by regions, and this holds the two together on setups with everything in them.
/// </summary>
public class BuildInputRegressionTests
{
    [TestCase(1, 1, 1, 1)]
    [TestCase(1, 3, 3, 3)]
    [TestCase(3, 2, 3, 2)]
    [TestCase(2, 5, 1, 4)]
    public void Materials_clamps_and_pressures_land_on_the_same_elements_and_faces_as_before(int cubes, int nx, int ny, int nz)
    {
        var coarse = Export(Bar(cubes));
        var setup = new SolverSetup();
        setup.SetDivisions(nx, ny, nz);
        // every kind of thing the user can set, on several cubes and cells
        setup.SetMaterial(new[] { coarse.ElementIds[0] }, "rubber");
        var some = new List<SubFace>();
        for (int hex = 0; hex < cubes; hex++)
            foreach (var side in new[] { "XMinus", "XPlus", "YMinus", "ZPlus" })
                some.AddRange(setup.Expand(coarse.ElementIds[hex], side, null, null).Where((_, i) => i % 2 == hex % 2));
        setup.SetFixed(some.Where((_, i) => i % 3 == 0), true);
        setup.SetLoads(some.Where((_, i) => i % 3 == 1), -2e6);
        setup.SetLoads(some.Where((_, i) => i % 6 == 4), -5e5);
        setup.SetElementMaterial(new[] { new ElementKey(coarse.ElementIds[^1], 0, 0, 0), new ElementKey(coarse.ElementIds[0], nx - 1, ny - 1, nz - 1) }, "bone");

        var problem = SolverFacade.BuildInput(setup, coarse);

        var fine = FineMesh.Build(coarse, nx, ny, nz);
        var cubeIndex = coarse.ElementIds.Select((id, i) => (id, i)).ToDictionary(t => t.id, t => t.i);
        ElementFace Old(SubFace f) { var (e, face) = fine.BoundaryElement(cubeIndex[f.Hex], f.Face, f.P, f.Q); return new ElementFace(e, face); }
        Assert.That(problem.Loads.Fixed.ToHashSet().SetEquals(setup.Fixed.Select(Old)), Is.True, "the clamped faces");
        Assert.That(problem.Loads.Fixed.Count, Is.EqualTo(setup.Fixed.Count));
        Assert.That(problem.Loads.Pressures.Select(p => (p.Face, p.Pn)).OrderBy(t => t.Face.Element).ThenBy(t => t.Face.Face),
            Is.EqualTo(setup.Loads.Select(l => (Old(l.Key), l.Value)).OrderBy(t => t.Item1.Element).ThenBy(t => t.Item1.Face)), "the pressed faces");
        for (int e = 0; e < fine.ElementCount; e++)
        {
            var key = new ElementKey(coarse.ElementIds[fine.ParentOf[e]], fine.Ex[e], fine.Ey[e], fine.Ez[e]);
            Assert.That(problem.Model.Materials[e].Name, Is.EqualTo(setup.MaterialOf(key)), $"material of element {e}");
        }
        if (fine.ElementCount > 1) Assert.That(problem.Model.Materials.Select(m => m.Name).Distinct().Count(), Is.GreaterThan(1), "the setup really had several materials");
    }
}
