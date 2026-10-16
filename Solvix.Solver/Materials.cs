using Solvix.Contracts.Facades;

namespace Solvix.Solver;

/// <summary>Ready-made materials every session starts with (E in Pa).</summary>
public static class Materials
{
    public const string DefaultName = "steel";

    public static IReadOnlyList<SolverMaterialDto> Presets { get; } = new[]
    {
        new SolverMaterialDto("steel", "Сталь", 2.1e11, 0.30),
        new SolverMaterialDto("aluminium", "Алюміній", 7.0e10, 0.33),
        new SolverMaterialDto("concrete", "Бетон", 3.0e10, 0.20),
        new SolverMaterialDto("rubber", "Гума", 1.0e7, 0.45),
        new SolverMaterialDto("enamel", "Емаль зуба", 8.0e10, 0.33),
        new SolverMaterialDto("dentin", "Дентин", 1.8e10, 0.31),
        new SolverMaterialDto("bone", "Кістка", 1.5e10, 0.30),
        new SolverMaterialDto("pulp", "Пульпа", 2.0e6, 0.45),
    };

    /// <summary>Null when valid, otherwise what is wrong.</summary>
    public static string? Problem(SolverMaterialDto m)
    {
        if (string.IsNullOrWhiteSpace(m.Name)) return "The material needs a name.";
        if (!double.IsFinite(m.E) || m.E <= 0) return $"{m.Label}: Young's modulus must be positive.";
        if (!double.IsFinite(m.Nu) || m.Nu < 0 || m.Nu >= 0.5) return $"{m.Label}: Poisson's ratio must be in [0, 0.5).";
        if (m.Color is not null && !System.Text.RegularExpressions.Regex.IsMatch(m.Color, "^#[0-9a-fA-F]{6}$")) return $"{m.Label}: the colour must be #rrggbb.";
        return null;
    }
}
