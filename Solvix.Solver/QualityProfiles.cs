using Solvix.Fem;

namespace Solvix.Solver;

/// <summary>All the measures of one small element that any profile may use.</summary>
internal readonly record struct ElementMeasures(ElementQualityMetrics Own, LinearHexMetrics Linear, BrickShape Shape);

/// <summary>
/// One measure of a profile: how to read it from the element and where it passes. With Levels = 4 the bounds are
/// the limits excellent | good | acceptable | poor; with Levels = 2 there is one limit and a value equal to it passes.
/// </summary>
internal sealed record QualityCriterion(
    string Key, string Label, string Short, string Tech, string Hint,
    bool HigherIsBetter, int Levels, double[] Bounds, string Unit, int Decimals, Func<ElementMeasures, double> Value, string Kind = "plain", double? ErrorLimit = null)
{
    /// <summary>True when the value is beyond the limit at which the element is unusable.</summary>
    public bool IsBeyondError(double value) => ErrorLimit is double limit && (double.IsNaN(value) || (HigherIsBetter ? value < limit : value > limit));

    public QualityGrade Grade(double value)
    {
        if (double.IsNaN(value)) return QualityGrade.Poor;
        if (Levels == 2) return (HigherIsBetter ? value >= Bounds[0] : value <= Bounds[0]) ? QualityGrade.Excellent : QualityGrade.Poor;
        return HigherIsBetter ? ElementQuality.GradeAbove(value, Bounds) : ElementQuality.GradeBelow(value, Bounds);
    }
}

/// <summary>A standard to judge the mesh by: the measures of one tool or of our own, each with its limits.</summary>
internal sealed record QualityProfile(string Id, string Name, string Source, string Note, IReadOnlyList<QualityCriterion> Criteria)
{
    /// <summary>
    /// The grade of an element: invalid when it is folded (the Jacobian changes sign), otherwise the worst of its
    /// measures. Going beyond a measure's error limit does not make it invalid: curved templates (the pipe) have
    /// elements far beyond ANSYS's Jacobian ratio error limit that the solver integrates correctly - see the research notes.
    /// </summary>
    public QualityGrade Grade(ElementMeasures m)
    {
        if (!(m.Own.MinDeterminant > 0) || m.Shape.JacobianRatio < 0) return QualityGrade.Invalid;
        var worst = QualityGrade.Excellent;
        foreach (var c in Criteria)
        {
            var grade = c.Grade(c.Value(m));
            if (grade > worst) worst = grade;
        }
        return worst;
    }
}

internal static class QualityProfiles
{
    public static readonly IReadOnlyList<QualityProfile> All = new[] { Solvix(), Abaqus(), Cubit(), Altair(), Ansys() };

    private static QualityCriterion C(string key, string label, string @short, string tech, string hint, bool higherIsBetter, int levels, double[] bounds, string unit, int decimals, Func<ElementMeasures, double> value, string kind = "plain", double? errorLimit = null) =>
        new(key, label, @short, tech, hint, higherIsBetter, levels, bounds, unit, decimals, value, kind, errorLimit);

    // Solvix's own criterion: the shape checks that ANSYS Mechanical APDL documents for the 20-node brick (Theory Reference,
    // 12.1 Element Shape Testing; see docs/research/mesh-quality). The warning limit is where an element stops being
    // accepted, the error limit is where the solver refuses it.
    private static QualityProfile Solvix() => new("solvix", "Solvix",
        "Критерії Solvix — перевірки форми, які ANSYS Mechanical APDL описує для 20-вузлової цеглини з вузлами на серединах ребер (Theory Reference, §12.1). Межа «попередження» — елемент не приймається. Межа «помилка» ANSYS показується, але розрахунок блокують лише вивернуті елементи.",
        "Міри рахуються по справжньому елементу: якобіан — у всіх 20 вузлах і центроїді, решта — по гранях і середніх перерізах (кутові вузли).", new[]
        {
            C("jacobianRatio", "Рівномірність якобіана", "Якобіан", "Jacobian ratio", "Найбільший визначник якобіана поділений на найменший (у 20 вузлах і центроїді). 1 — ідеал: протилежні грані паралельні, а вузли на серединах ребер стоять посередині. Сильний зсув вузла від середини ребра збільшує ratio, а за чвертю ребра елемент ламається.",
                false, 2, new[] { 30.0 }, "", 1, m => Finite(m.Shape.JacobianRatio < 0 ? 1e9 : m.Shape.JacobianRatio), "plain", 1000),
            C("aspectRatio", "Витягнутість", "Витягнутість", "Aspect ratio", "Наскільки витягнуті грані й середні перерізи: відношення сторін найбільш витягнутого прямокутника. Квадрат — 1. Сам по собі слабо впливає на точність, поки не вийде за ~1000.",
                false, 2, new[] { 20.0 }, "", 1, m => Finite(m.Shape.AspectRatio), "plain", 1_000_000),
            C("parallelDeviation", "Непаралельність протилежних ребер", "Паралельність", "Parallel deviation", "Кут між протилежними ребрами граней і перерізів (серединні вузли не враховуються). 0° — прямокутник; конічність і сильний перекіс це збільшують.",
                false, 2, new[] { 100.0 }, "°", 0, m => m.Shape.ParallelDeviation, "plain", 170),
            C("maxCornerAngle", "Найбільший кут", "Макс. кут", "Maximum corner angle", "Найбільший кут у кутку грані чи перерізу (кутові вузли). 90° — прямокутник. Тупий кут псує збіжність.",
                false, 2, new[] { 165.0 }, "°", 0, m => m.Shape.MaxCornerAngle, "plain", 179.9),
            C("minCornerAngle", "Найменший кут", "Мін. кут", "Minimum corner angle", "Найменший кут у кутку грані чи перерізу (кутові вузли). 90° — прямокутник. Гострий кут псує точність. Це не перевірка ANSYS: Solvix додає її сам (межа 15°), бо гострий кут може ховатися за прийнятним найбільшим.",
                true, 2, new[] { 15.0 }, "°", 0, m => m.Shape.MinCornerAngle),
            C("warpingFactor", "Викривлення граней", "Викривлення", "Warping factor", "Наскільки грань не лежить в одній площині: різниця висот кутів вздовж ребра, поділена на корінь із площі. 0 — плоска грань.",
                false, 2, new[] { 0.2 }, "", 2, m => Finite(m.Shape.WarpingFactor), "plain", 0.4),
        });

    // Abaqus/CAE "Verify mesh" defaults for hexahedra
    private static QualityProfile Abaqus() => new("abaqus", "Abaqus/CAE", "Verify mesh: стандартні межі для гексаедрів — кут грані від 10° до 160°, aspect ratio не більше 10.",
        "Лише «проходить / не проходить». Кути і довжини ребер — за кутовими вузлами (прямі ребра).", new[]
        {
            C("faceMinAngle", "Найменший кут грані", "Мін. кут", "Smaller face corner angle", "Найменший кут між ребрами в кутку грані. Abaqus попереджає, якщо менший за 10°.", true, 2, new[] { 10.0 }, "°", 0, m => m.Linear.FaceMinAngle),
            C("faceMaxAngle", "Найбільший кут грані", "Макс. кут", "Larger face corner angle", "Найбільший кут між ребрами в кутку грані. Abaqus попереджає, якщо більший за 160°.", false, 2, new[] { 160.0 }, "°", 0, m => m.Linear.FaceMaxAngle),
            C("aspectRatio", "Витягнутість", "Витягнутість", "Aspect ratio", "Найдовше ребро поділене на найкоротше. Abaqus попереджає від 10.", false, 2, new[] { 10.0 }, "", 1, m => Finite(m.Linear.EdgeRatio)),
        });

    // Sandia Cubit / Verdict: the "acceptable range" of each hexahedral metric
    private static QualityProfile Cubit() => new("cubit", "Cubit (Sandia)", "Допустимі діапазони метрик гексаедра з довідника Cubit (бібліотека Verdict).",
        "Лише «проходить / не проходить». Усе рахується по восьми кутових вузлах. Формули taper, shear, shape і condition no. відтворені за описом з довідника, а не з вихідного коду Verdict — можливі дрібні розбіжності.", new[]
        {
            C("scaledJacobian", "Форма (Scaled Jacobian)", "Scaled J.", "Scaled Jacobian", "Найменший якобіан у кутах, поділений на довжини трьох ребер. Допустимо 0.5–1.", true, 2, new[] { 0.5 }, "", 2, m => m.Linear.ScaledJacobian),
            C("aspectRatio", "Витягнутість", "Витягнутість", "Aspect ratio", "Відношення довжин головних осей елемента в центрі. Допустимо 1–4.", false, 2, new[] { 4.0 }, "", 1, m => Finite(m.Linear.AxesAspect)),
            C("skew", "Нахил осей", "Skew", "Skew", "Найбільший |cos| кута між головними осями в центрі. Допустимо 0–0.5.", false, 2, new[] { 0.5 }, "", 2, m => m.Linear.Skew),
            C("taper", "Звуження", "Taper", "Taper", "Наскільки протилежні ребра різної довжини (конус). Допустимо 0–0.4.", false, 2, new[] { 0.4 }, "", 2, m => Finite(m.Linear.Taper)),
            C("stretch", "Розтяг", "Stretch", "Stretch", "√3 · найкоротше ребро / найдовша діагональ. Допустимо 0.25–1.", true, 2, new[] { 0.25 }, "", 2, m => m.Linear.Stretch),
            C("diagonal", "Діагоналі", "Діагоналі", "Diagonal ratio", "Найкоротша діагональ / найдовша. Допустимо 0.65–1.", true, 2, new[] { 0.65 }, "", 2, m => m.Linear.DiagonalRatio),
            C("condition", "Обумовленість", "Condition", "Condition no.", "Найбільше число обумовленості якобіана в кутах (куб — 1). Допустимо 1–8.", false, 2, new[] { 8.0 }, "", 1, m => Finite(m.Linear.ConditionNumber)),
            C("shear", "Зсув (shear)", "Shear", "Shear", "Якість кутів без урахування довжин ребер. Допустимо 0.3–1.", true, 2, new[] { 0.3 }, "", 2, m => m.Linear.Shear),
            C("shape", "Форма (shape)", "Shape", "Shape", "Якість форми з урахуванням довжин ребер. Допустимо 0.3–1.", true, 2, new[] { 0.3 }, "", 2, m => m.Linear.Shape),
        });

    // Altair HyperMesh: what its documentation calls generally acceptable
    private static QualityProfile Altair() => new("altair", "Altair HyperMesh", "Довідка HyperMesh: aspect ratio рідко має перевищувати 5, відношення якобіанів у точках Гауса — не менше 0.7.",
        "Лише «проходить / не проходить». Ще є перевірка викривлення граней (warpage до 5°) — тут вона не рахується.", new[]
        {
            C("aspectRatio", "Витягнутість", "Витягнутість", "Aspect ratio", "Найдовше ребро поділене на найкоротше. Рідко більше 5.", false, 2, new[] { 5.0 }, "", 1, m => Finite(m.Linear.EdgeRatio)),
            C("jacobian", "Відношення якобіанів", "Якобіан", "Jacobian (Gauss points)", "Найменший якобіан / найбільший у точках Гауса. Загалом прийнятно від 0.7.", true, 2, new[] { 0.7 }, "", 2, m => m.Own.GaussJacobianRatio),
        });

    // ANSYS: the skewness scale (0 equiangular ... 1 degenerate)
    private static QualityProfile Ansys() => new("ansys", "ANSYS CFD (skewness)", "Шкала skewness від ANSYS: 0–0.25 відмінно, 0.25–0.5 добре, 0.5–0.75 задовільно, вище — погано (0.9–1 — «голка»).",
        "Skewness тут — еквіутова: найбільше відхилення кута грані від 90°, поділене на 90°. ANSYS для гексаедрів може рахувати інакше (за нормалями граней), тож числа можуть відрізнятися.", new[]
        {
            C("equiangleSkew", "Нерівнокутність", "Skewness", "Equiangle skewness", "0 — усі кути прямі, 1 — виродження.", false, 4, new[] { 0.25, 0.5, 0.75 }, "", 2, m => m.Linear.EquiangleSkew),
        });

    // JSON has no infinity
    private static double Finite(double v) => double.IsNaN(v) ? 1e9 : Math.Clamp(v, -1e9, 1e9);
}
