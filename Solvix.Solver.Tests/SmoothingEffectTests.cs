using NUnit.Framework;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

public class SmoothingEffectTests
{
    private static HexMeshEditor Rough()
    {
        var editor = new HexMeshEditor();
        Assert.That(editor.AddBody(HexTemplates.Kind("rough-block").Build(new Dictionary<string, double> { ["jitter"] = 0.25, ["seed"] = 3 })).Ok, Is.True);
        return editor;
    }

    private static (int Rejected, double MinAngle, double Skew, double Scaled) Worst(HexMeshEditor editor)
    {
        var q = NewFacade().Quality(1, Export(editor)).Profiles.Single(p => p.Id == "solvix");
        return (q.grades_poor(), q.Worst["minCornerAngle"], q.Worst["equiangleSkew"], q.Worst["scaledJacobian"]);
    }

    [Test]
    public void Smoothing_improves_the_worst_numbers_of_the_rough_block()
    {
        var editor = Rough();
        var before = Worst(editor);

        Assert.That(editor.Smooth(100, 0.5).Ok, Is.True);
        var after = Worst(editor);
        TestContext.Out.WriteLine($"BEFORE rejected {before.Rejected} minAngle {before.MinAngle:0.0} skew {before.Skew:0.00} scaledJ {before.Scaled:0.00}");
        TestContext.Out.WriteLine($"AFTER  rejected {after.Rejected} minAngle {after.MinAngle:0.0} skew {after.Skew:0.00} scaledJ {after.Scaled:0.00}");

        Assert.That(after.MinAngle, Is.GreaterThan(before.MinAngle));
        Assert.That(after.Scaled, Is.GreaterThan(before.Scaled));
        Assert.That(after.Rejected, Is.LessThanOrEqualTo(before.Rejected));
    }
}

internal static class QualityExtensions
{
    public static int grades_poor(this Solvix.Contracts.Facades.SolverQualityDto q) => q.Grades.GetValueOrDefault("poor") + q.Grades.GetValueOrDefault("invalid");
}
