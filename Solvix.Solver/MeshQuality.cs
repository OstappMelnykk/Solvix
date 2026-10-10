using Solvix.Contracts.Facades;
using Solvix.Fem;

namespace Solvix.Solver;

/// <summary>
/// Quality of the mesh the solver would work on (every cube cut into the current division), judged element by
/// element - the small elements are what the solver integrates - by each of several standards (see QualityProfiles).
/// </summary>
internal static class MeshQuality
{
    public static SolverQualityReportDto Evaluate(SolverSetup setup, FemMeshDto mesh)
    {
        if (mesh.ElementCount == 0) return new SolverQualityReportDto(QualityProfiles.All.Select(p => Report(p, null, Array.Empty<ElementMeasures>())).ToList());

        var (nx, ny, nz) = setup.Divisions;
        var fine = FineMesh.Build(mesh, nx, ny, nz);
        var measures = new ElementMeasures[fine.ElementCount];
        Parallel.For(0, fine.ElementCount, e =>
        {
            var xyz = new double[Hex20.Nodes, 3];
            for (int i = 0; i < Hex20.Nodes; i++)
                for (int c = 0; c < 3; c++) xyz[i, c] = fine.Positions[fine.Connectivity[e, i], c];
            measures[e] = new ElementMeasures(ElementQuality.Of(xyz), LinearHexMetrics.Of(xyz), BrickShape.Of(xyz));
        });
        return new SolverQualityReportDto(QualityProfiles.All.Select(p => Report(p, (mesh, fine), measures)).ToList());
    }

    /// <summary>Every standard's judgement of one small element, with its value of every measure of that standard.</summary>
    public static SolverElementReportDto? OfElement(SolverSetup setup, FemMeshDto mesh, int hex, int ex, int ey, int ez)
    {
        int cube = Array.IndexOf(mesh.ElementIds.ToArray(), hex);
        var (nx, ny, nz) = setup.Divisions;
        if (cube < 0 || ex < 0 || ex >= nx || ey < 0 || ey >= ny || ez < 0 || ez >= nz) return null;
        var xyz = FineMesh.ElementCoordinates(mesh, nx, ny, nz, cube, ex, ey, ez);
        var m = new ElementMeasures(ElementQuality.Of(xyz), LinearHexMetrics.Of(xyz), BrickShape.Of(xyz));
        var profiles = QualityProfiles.All.Select(p =>
        {
            var values = p.Criteria.ToDictionary(c => c.Key, c => c.Value(m));
            return new SolverElementProfileDto(p.Id, Name(p.Grade(m)), values);
        }).ToList();
        return new SolverElementReportDto(hex, ex, ey, ez, profiles);
    }

    private static SolverQualityDto Report(QualityProfile profile, (FemMeshDto Mesh, FineMesh Fine)? where, ElementMeasures[] measures)
    {
        var grades = new Dictionary<string, int> { ["excellent"] = 0, ["good"] = 0, ["acceptable"] = 0, ["poor"] = 0, ["invalid"] = 0 };
        var worst = new Dictionary<string, double>();
        foreach (var c in profile.Criteria) worst[c.Key] = c.HigherIsBetter ? double.MaxValue : double.MinValue;
        var flagged = new List<SolverElementQualityDto>();

        for (int e = 0; e < measures.Length; e++)
        {
            var m = measures[e];
            var grade = profile.Grade(m);
            grades[Name(grade)]++;
            var values = new Dictionary<string, double>();
            foreach (var c in profile.Criteria)
            {
                double v = c.Value(m);
                values[c.Key] = v;
                worst[c.Key] = c.HigherIsBetter ? Math.Min(worst[c.Key], v) : Math.Max(worst[c.Key], v);
            }
            if (grade == QualityGrade.Excellent || where is null) continue;
            var (mesh, fine) = where.Value;
            flagged.Add(new SolverElementQualityDto(mesh.ElementIds[fine.ParentOf[e]], fine.Ex[e], fine.Ey[e], fine.Ez[e], Name(grade), values));
        }

        if (measures.Length == 0)
        {
            worst.Clear();
            foreach (var c in profile.Criteria) worst[c.Key] = c.Levels == 2 ? c.Bounds[0] : c.HigherIsBetter ? 1 : 0;
        }

        var limits = profile.Criteria.Select(c => new SolverQualityLimitDto(c.Key, c.Label, c.Short, c.Tech, c.Hint, c.HigherIsBetter, c.Levels, c.Bounds, c.Unit, c.Decimals, c.Kind, c.ErrorLimit)).ToList();
        return new SolverQualityDto(profile.Id, profile.Name, profile.Source, profile.Note, measures.Length, grades, worst, limits, flagged);
    }

    public static string Name(QualityGrade grade) => grade.ToString().ToLowerInvariant();
}
