using Solvix.FemMesh.Local;

namespace Solvix.FemMesh.Tests.Local;

public class PreviewTests
{
    private static string Signature(HexMesh mesh) =>
        string.Join(";", mesh.Cells.Values
            .Select(c => string.Join(",", c.Nodes.Select(mesh.PointOf).Select(p => $"{p.X}:{p.Y}:{p.Z}")))
            .OrderBy(s => s, StringComparer.Ordinal));

    [Test]
    public void The_preview_shows_the_stages_in_order_ends_in_the_same_mesh_as_refining_and_leaves_the_original_alone()
    {
        var a = HexMesh.Grid(4, 4, 4);
        var b = a.Clone();
        var cells = a.Roots.Where(r => (r.I, r.J, r.K) is (1, 1, 1) or (2, 2, 1)).SelectMany(r => r.Leaves).ToList();
        string before = Signature(a);

        var steps = Refiner.Preview(a, cells, 3, 2, 2);
        Refiner.Refine(b, cells, 3, 2, 2);

        Assert.That(steps.First().Kind, Is.EqualTo("start"));
        Assert.That(steps.Last().Kind, Is.EqualTo("final"));
        var inner = steps.Skip(1).Take(steps.Count - 2).Select(s => s.Kind == "seam" ? "layers" : s.Kind).Distinct().ToList();
        Assert.That(inner, Is.EqualTo(new[] { "layers", "marks", "templates", "expand" }));
        Assert.That(steps.Where(s => s.Kind == "marks").Select(s => s.Axis), Is.EqualTo(new[] { 0, 1, 2 }));
        Assert.That(Signature(a), Is.EqualTo(before), "the preview must not change the mesh it was given");
        Assert.That(Signature(steps[^1].Mesh!), Is.EqualTo(Signature(b)));
        foreach (var step in steps.Where(s => s.Kind is "expand" or "final")) Assert.That(Conformity.Check(step.Mesh!), Is.Empty, step.Kind);
        foreach (var step in steps.Where(s => s.Kind == "templates")) Assert.That(step.Applied, Is.Not.Empty);
    }

    [Test]
    public void Every_step_in_choosing_the_seams_of_a_cells_own_describes_the_choice_truthfully()
    {
        var random = new Random(71);
        int guesses = 0, changes = 0;
        for (int trial = 0; trial < 40; trial++)
        {
            var mesh = HexMesh.Grid(random.Next(2, 4), random.Next(2, 4), random.Next(2, 4));
            Refiner.Refine(mesh, mesh.Roots.Where(_ => random.NextDouble() < 0.4).SelectMany(r => r.Leaves).ToList(), 2, 2, 2);
            var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.06).ToList();
            if (leaves.Count == 0) continue;

            var steps = Refiner.Preview(mesh, leaves, 2, 2, 2);

            for (int k = 0; k < steps.Count; k++)
            {
                if (steps[k].Kind != "seam") continue;
                var t = steps[k].Try!;
                Assert.That(steps[k].Mesh, Is.Null);
                Assert.That(t.Kind, Is.AnyOf("guess", "refused", "change"));
                Assert.That(t.Side, Is.InRange(-1, 1));
                Assert.That(t.FaceNodes, Has.Count.EqualTo(t.Side >= 0 ? 4 : 0));
                Assert.That(t.Added.Intersect(t.FaceNodes), Is.Empty);
                Assert.That(t.CutAcross, Is.EqualTo(!t.Uncut.Contains(t.Cell)), "CutAcross must agree with the list of the cells still not cut");
                if (t.Kind != "change") guesses++;
                else changes++;
            }
        }
        TestContext.Out.WriteLine($"SEAMS3D guesses {guesses}, changes {changes}");
        Assert.That(guesses, Is.GreaterThan(0));
    }
}
