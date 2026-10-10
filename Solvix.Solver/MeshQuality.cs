using Solvix.Contracts.Facades;
using Solvix.Fem;

namespace Solvix.Solver;

/// <summary>Quality of the mesh the solver would work on, aggregated per cube (the worst of its small elements).</summary>
internal static class MeshQuality
{
    public static SolverQualityDto Evaluate(SolverSetup setup, FemMeshDto mesh)
    {
        var grades = new Dictionary<string, int> { ["excellent"] = 0, ["good"] = 0, ["acceptable"] = 0, ["poor"] = 0, ["invalid"] = 0 };
        if (mesh.ElementCount == 0) return new SolverQualityDto(0, grades, 1, 1, 1, 0, 90, 90, Array.Empty<SolverCubeQualityDto>(), Limits, Array.Empty<SolverElementQualityDto>());

        var (nx, ny, nz) = setup.Divisions;
        var fine = FineMesh.Build(mesh, nx, ny, nz);
        var metrics = new ElementQualityMetrics[fine.ElementCount];
        Parallel.For(0, fine.ElementCount, e =>
        {
            var xyz = new double[Hex20.Nodes, 3];
            for (int i = 0; i < Hex20.Nodes; i++)
                for (int c = 0; c < 3; c++) xyz[i, c] = fine.Positions[fine.Connectivity[e, i], c];
            metrics[e] = ElementQuality.Of(xyz);
        });

        var cubes = new List<SolverCubeQualityDto>();
        for (int cube = 0; cube < mesh.ElementCount; cube++)
        {
            var own = Enumerable.Range(cube * fine.ElementsPerCube, fine.ElementsPerCube).Select(e => metrics[e]).ToList();
            var worst = own.OrderByDescending(m => (int)m.Grade).ThenBy(m => m.ScaledJacobian).First();
            cubes.Add(new SolverCubeQualityDto(mesh.ElementIds[cube], Name(worst.Grade), own.Min(m => m.ScaledJacobian), own.Min(m => m.JacobianRatio), own.Max(m => m.AspectRatio), own.Max(m => m.MaxSkewDegrees), own.Min(m => m.MinAngleDegrees), own.Max(m => m.MaxAngleDegrees)));
        }
        foreach (var m in metrics) grades[Name(m.Grade)]++;
        return new SolverQualityDto(
            fine.ElementCount, grades,
            metrics.Min(m => m.ScaledJacobian), metrics.Min(m => m.JacobianRatio), metrics.Max(m => m.AspectRatio), metrics.Max(m => m.MaxSkewDegrees), metrics.Min(m => m.MinAngleDegrees), metrics.Max(m => m.MaxAngleDegrees),
            cubes, Limits, Flagged(mesh, fine, metrics));
    }

    // the small elements that are not excellent in every measure - the rest are drawn and counted as excellent
    private static List<SolverElementQualityDto> Flagged(FemMeshDto mesh, FineMesh fine, ElementQualityMetrics[] metrics)
    {
        var flagged = new List<SolverElementQualityDto>();
        for (int e = 0; e < metrics.Length; e++)
        {
            var m = metrics[e];
            if (m.Grade == QualityGrade.Excellent) continue;
            flagged.Add(new SolverElementQualityDto(mesh.ElementIds[fine.ParentOf[e]], fine.Ex[e], fine.Ey[e], fine.Ez[e], Name(m.Grade), m.ScaledJacobian, m.JacobianRatio, m.AspectRatio, m.MaxSkewDegrees, m.MinAngleDegrees, m.MaxAngleDegrees));
        }
        return flagged;
    }

    private static readonly IReadOnlyList<SolverQualityLimitDto> Limits = new[]
    {
        new SolverQualityLimitDto("scaledJacobian", "Scaled Jacobian", "detJ / (довжини трьох напрямів): 1 — ідеальний куб, 0 — виродження, <0 — вивернутий елемент", true, true, ElementQuality.ScaledJacobianLimits),
        new SolverQualityLimitDto("jacobianRatio", "Відношення якобіанів", "min detJ / max detJ: наскільки рівномірно елемент розтягує простір", true, true, ElementQuality.JacobianRatioLimits),
        new SolverQualityLimitDto("aspectRatio", "Aspect ratio", "довше ребро / коротше ребро", false, true, ElementQuality.AspectRatioLimits),
        new SolverQualityLimitDto("skew", "Кути, °", "відхилення від прямого кута: кути граней у вершинах і двогранні кути між гранями; 60–120° відмінно, 45–135° добре, 15–165° прийнятно, поза цим погано", false, true, ElementQuality.SkewLimits),
    };

    public static string Name(QualityGrade grade) => grade.ToString().ToLowerInvariant();
}
