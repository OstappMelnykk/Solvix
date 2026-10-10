namespace Solvix.Mesh;

/// <summary>One adjustable number of a template (a radius, a count of cubes, a wall thickness...).</summary>
public sealed record TemplateParameter(string Key, string Label, double Default, double Min, double Max, bool Integer);

/// <summary>A named starting point: a kind with its own values for the parameters.</summary>
public sealed record TemplatePreset(string Name, string Label, string Kind, IReadOnlyDictionary<string, double> Values);

/// <summary>
/// A family of bodies (a pipe, a sphere, a torus...). The kind fixes the cube layout on the ideal
/// lattice - a pipe is always a closed ring of cells around a hole - and the parameters only
/// size and refine it, so a pipe stays a pipe whatever the radius, length or number of cubes.
/// </summary>
public sealed class TemplateKind
{
    internal TemplateKind(string name, string label, string group, IReadOnlyList<TemplateParameter> parameters, Func<TemplateValues, BodyPlan> build)
    {
        Name = name;
        Label = label;
        Group = group;
        Parameters = parameters;
        _build = build;
    }

    private readonly Func<TemplateValues, BodyPlan> _build;

    public string Name { get; }
    public string Label { get; }
    public string Group { get; }
    public IReadOnlyList<TemplateParameter> Parameters { get; }

    public IReadOnlyDictionary<string, double> Defaults => Parameters.ToDictionary(p => p.Key, p => p.Default);

    /// <summary>
    /// Builds the body. Missing parameters take their defaults, integer ones are rounded; an unknown
    /// parameter, a value out of range or an impossible combination (a wall thicker than the radius)
    /// is an <see cref="ArgumentException"/> whose message says what to change.
    /// </summary>
    public BodyPlan Build(IReadOnlyDictionary<string, double>? values)
    {
        var resolved = new Dictionary<string, double>();
        foreach (var key in values?.Keys ?? Enumerable.Empty<string>())
            if (Parameters.All(p => p.Key != key)) throw new ArgumentException($"'{Label}' has no parameter '{key}'.");
        foreach (var p in Parameters)
        {
            double v = values is not null && values.TryGetValue(p.Key, out var given) ? given : p.Default;
            if (!double.IsFinite(v)) throw new ArgumentException($"{p.Label}: the value must be a finite number.");
            if (p.Integer) v = Math.Round(v);
            if (v < p.Min || v > p.Max) throw new ArgumentException($"{p.Label}: {v} is outside {p.Min}..{p.Max}.");
            resolved[p.Key] = v;
        }
        var plan = _build(new TemplateValues(resolved));
        if (plan.Cells.Count > HexTemplates.MaxCubes)
            throw new ArgumentException($"The body would have {plan.Cells.Count} cubes; the limit is {HexTemplates.MaxCubes}. Use fewer cubes.");
        return plan;
    }
}

internal sealed class TemplateValues(IReadOnlyDictionary<string, double> values)
{
    public double this[string key] => values[key];
    public int Int(string key) => (int)values[key];
}

/// <summary>
/// The library of typical bodies. Each kind builds its cubes from a smooth map of the ideal
/// lattice onto the real shape: every one of a cube's 20 nodes - corners and edge midpoints
/// alike - is the image of its ideal point, so the curved surface is carried by real nodes while
/// the ideal world stays an ordinary lattice of unit cells.
/// </summary>
public static class HexTemplates
{
    public const int MaxCubes = 6000;

    public static IReadOnlyList<TemplateKind> Kinds { get; } = BuildKinds();
    public static IReadOnlyList<TemplatePreset> Presets { get; } = BuildPresets();

    public static TemplateKind Kind(string name) =>
        Kinds.FirstOrDefault(k => k.Name == name) ?? throw new ArgumentException($"Unknown template '{name}'.");

    // ---------------------------------------------------------------------------------------
    // building blocks

    private static TemplateParameter P(string key, string label, double def, double min, double max, bool integer = false) =>
        new(key, label, def, min, max, integer);

    // Cells of an nx*ny*nz grid kept by a mask, each node placed by `map` (ideal lattice point -> real).
    private static BodyPlan Plan(int nx, int ny, int nz, Func<int, int, int, bool> keep, Func<Vec3, Vec3> map, Func<int, int, int, string?>? layerOf = null)
    {
        var cells = new List<BodyCell>();
        for (int i = 0; i < nx; i++)
            for (int j = 0; j < ny; j++)
                for (int k = 0; k < nz; k++)
                {
                    if (!keep(i, j, k)) continue;
                    var positions = new Vec3[Hex20Reference.NodeCount];
                    for (int s = 0; s < positions.Length; s++)
                        positions[s] = map(new Vec3(
                            i + (Hex20Reference.LocalCoords[s, 0] + 1) / 2.0,
                            j + (Hex20Reference.LocalCoords[s, 1] + 1) / 2.0,
                            k + (Hex20Reference.LocalCoords[s, 2] + 1) / 2.0));
                    cells.Add(new BodyCell(i, j, k, positions, layerOf?.Invoke(i, j, k)));
                }
        return new BodyPlan(cells);
    }

    // A cell's distance from the outside of an n-wide grid: 0 for the outer layer, 1 for the next...
    private static int Layer(int index, int count) => Math.Min(index, count - 1 - index);

    // How the round shape takes over from the square lattice. A cell in the corner of the lattice has
    // two (or, on a sphere, three) faces on the round surface; where those faces meet, a smooth surface
    // is flat, and the cell collapses (zero or negative Jacobian). The cure is to push the nodes right at
    // the ridges slightly outwards, so the surface has a faint crease there and the cell keeps a proper
    // corner. How much is needed depends on how many cubes the surface is cut into, so the builders try a
    // few strengths and keep the first that leaves no cube folded (see Fit).
    internal sealed record Rounding(double EdgePull, double EdgeWidth, double CornerPull, double CornerWidth);

    // Shapes of the push (how far along the ridge it reaches, and how the corner pushes relative to the edge);
    // its strength is then searched for: the weakest that leaves no cube folded.
    private static readonly (double Edge, double EdgeWidth, double Corner, double CornerWidth)[] RoundingShapes =
    {
        (1, 2, 4, 4), (1, 3, 4, 6), (1, 2, 8, 6),
    };

    private const double MinStrength = 0.004, MaxStrength = 4;

    private static bool IsFolded(BodyCell cell) => Hex20Geometry.MinDeterminant(cell.Positions) <= 1e-9;

    // For each shape of push, doubles the strength from a tiny value until no cube is folded, then bisects down
    // to the weakest strength that still works; the body bent the least wins. When nothing works, the strongest
    // push with the fewest folded cubes is kept (the editor flags those cubes as usual).
    private static BodyPlan Fit(Func<Rounding, BodyPlan> build) => FitWith(build).Plan;

    private static (Rounding Rounding, BodyPlan Plan) FitWith(Func<Rounding, BodyPlan> build)
    {
        BodyPlan? best = null;
        Rounding? bestRounding = null;
        Rounding? fallbackRounding = null;
        double bestStrength = double.MaxValue;
        BodyPlan? fallback = null;
        int fallbackFolded = int.MaxValue;
        foreach (var shape in RoundingShapes)
        {
            Rounding At(double k) => new(shape.Edge * k, shape.EdgeWidth, shape.Corner * k, shape.CornerWidth);
            double low = 0, high = MinStrength;
            BodyPlan? plan = null;
            while (high <= MaxStrength && high < bestStrength)
            {
                var attempt = build(At(high));
                int folded = attempt.Cells.Count(IsFolded);
                if (folded < fallbackFolded) (fallback, fallbackFolded, fallbackRounding) = (attempt, folded, At(high));
                if (folded == 0) { plan = attempt; break; }
                low = high;
                high *= 2;
            }
            if (plan is null) continue;
            for (int i = 0; i < 5; i++)
            {
                double mid = (low + high) / 2;
                var attempt = build(At(mid));
                if (attempt.Cells.Any(IsFolded)) low = mid;
                else { high = mid; plan = attempt; }
            }
            if (high < bestStrength) (best, bestStrength, bestRounding) = (plan, high, At(high));
        }
        return best is not null ? (bestRounding!, best) : (fallbackRounding ?? RoundingShapes.Select(x => new Rounding(x.Edge, x.EdgeWidth, x.Corner, x.CornerWidth)).First(), fallback!);
    }

    // Outward push at the ridges of a square (2D) or a cube (3D), as a factor on the radius: 1 away from them.
    private static double Ridge2(double u, double w, int cells, Rounding r) =>
        1 + r.EdgePull / cells * Math.Max(0, 1 - cells / 2.0 * ((1 - Math.Abs(u)) + (1 - Math.Abs(w))) / r.EdgeWidth);

    private static double Ridge3(double u, double v, double w, int cells, Rounding r)
    {
        var gap = new[] { 1 - Math.Abs(u), 1 - Math.Abs(v), 1 - Math.Abs(w) };
        Array.Sort(gap);
        return (1 + r.EdgePull / cells * Math.Max(0, 1 - cells / 2.0 * (gap[0] + gap[1]) / r.EdgeWidth))
             * (1 + r.CornerPull / cells * Math.Max(0, 1 - cells / 2.0 * (gap[0] + gap[1] + gap[2]) / r.CornerWidth));
    }

    // Square -> disc: concentric square rings become concentric circles (the more so the further out).
    private static (double X, double Y) Disc(double u, double w, int cells, Rounding r)
    {
        double length = Math.Sqrt(u * u + w * w);
        if (length < 1e-12) return (0, 0);
        double radius = Math.Max(Math.Abs(u), Math.Abs(w));
        double scale = (1 + (radius / length - 1) * Math.Pow(Math.Min(radius, 1), 3)) * Ridge2(u, w, cells, r);
        return (u * scale, w * scale);
    }

    // Cube -> ball, the same idea in 3D: the cube's edges get the edge push, its corners the corner push.
    private static Vec3 Ball(double u, double v, double w, int cells, Rounding r)
    {
        double length = Math.Sqrt(u * u + v * v + w * w);
        if (length < 1e-12) return Vec3.Zero;
        double radius = Math.Max(Math.Abs(u), Math.Max(Math.Abs(v), Math.Abs(w)));
        double scale = (1 + (radius / length - 1) * Math.Pow(Math.Min(radius, 1), 3)) * Ridge3(u, v, w, cells, r);
        return new Vec3(u * scale, v * scale, w * scale);
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new ArgumentException(message);
    }

    // ---------------------------------------------------------------------------------------
    // kinds

    private static IReadOnlyList<TemplateKind> BuildKinds() => new[]
    {
        Block(), BoxShell(), Cylinder(), Pipe(), Sphere(), HollowSphere(), Hemisphere(), Torus(), PlateWithHole(),
        LProfile(), TProfile(), UProfile(), Cross(), Stairs(),
    };

    private static TemplateKind Block() => new("block", "Брус", "Прямі", new[]
    {
        P("countX", "Кубів по X", 3, 1, 40, true), P("countY", "Кубів по Y", 2, 1, 40, true), P("countZ", "Кубів по Z", 2, 1, 40, true),
        P("length", "Довжина (X)", 3, 0.01, 1000), P("height", "Висота (Y)", 2, 0.01, 1000), P("depth", "Ширина (Z)", 2, 0.01, 1000),
    }, v =>
    {
        int nx = v.Int("countX"), ny = v.Int("countY"), nz = v.Int("countZ");
        return Plan(nx, ny, nz, (_, _, _) => true, p => new Vec3(p.X / nx * v["length"], p.Y / ny * v["height"], p.Z / nz * v["depth"]));
    });

    private static TemplateKind BoxShell() => new("box-shell", "Порожня коробка", "Прямі", new[]
    {
        P("countX", "Кубів по X", 5, 3, 40, true), P("countY", "Кубів по Y", 4, 3, 40, true), P("countZ", "Кубів по Z", 5, 3, 40, true),
        P("wallCells", "Стінка, кубів", 1, 1, 10, true),
        P("length", "Довжина (X)", 5, 0.01, 1000), P("height", "Висота (Y)", 4, 0.01, 1000), P("depth", "Ширина (Z)", 5, 0.01, 1000),
    }, v =>
    {
        int nx = v.Int("countX"), ny = v.Int("countY"), nz = v.Int("countZ"), t = v.Int("wallCells");
        Require(2 * t < Math.Min(nx, Math.Min(ny, nz)), "Стінка занадто товста: усередині має лишитись порожнина (зменшіть стінку або збільште кількість кубів).");
        return Plan(nx, ny, nz, (i, j, k) => Math.Min(Layer(i, nx), Math.Min(Layer(j, ny), Layer(k, nz))) < t,
            p => new Vec3(p.X / nx * v["length"], p.Y / ny * v["height"], p.Z / nz * v["depth"]));
    });

    private static TemplateKind Cylinder() => new("cylinder", "Циліндр / конус", "Циліндричні", new[]
    {
        P("around", "Кубів по діаметру", 6, 2, 40, true), P("along", "Кубів вздовж осі", 4, 1, 60, true),
        P("radiusX", "Радіус по X", 1, 0.01, 1000), P("radiusZ", "Радіус по Z", 1, 0.01, 1000), P("height", "Висота", 2, 0.01, 1000),
        P("topScale", "Верх відносно низу (1 = циліндр)", 1, 0.05, 20),
    }, v =>
    {
        int n = v.Int("around"), m = v.Int("along");
        double c = n / 2.0;
        return Fit(r => Plan(n, m, n, (_, _, _) => true, p =>
        {
            var d = Disc((p.X - c) / c, (p.Z - c) / c, n, r);
            double t = p.Y / m, s = 1 + (v["topScale"] - 1) * t;
            return new Vec3(c + v["radiusX"] * s * d.X, v["height"] * t, c + v["radiusZ"] * s * d.Y);
        }));
    });

    private static TemplateKind Pipe() => new("pipe", "Труба (порожнина всередині)", "Циліндричні", new[]
    {
        P("around", "Кубів по діаметру", 8, 4, 40, true), P("wallCells", "Стінка, кубів", 1, 1, 10, true), P("along", "Кубів вздовж осі", 4, 1, 60, true),
        P("radiusX", "Зовнішній радіус по X", 1, 0.01, 1000), P("radiusZ", "Зовнішній радіус по Z", 1, 0.01, 1000), P("height", "Довжина", 3, 0.01, 1000),
        P("wall", "Товщина стінки", 0.25, 0.001, 1000), P("topScale", "Кінець відносно початку (1 = пряма)", 1, 0.05, 20),
    }, v =>
    {
        int n = v.Int("around"), m = v.Int("along"), t = v.Int("wallCells");
        Require(n - 2 * t >= 1, "Стінка у кубах занадто товста: у трубі має лишитись хоч один куб порожнини (збільште «кубів по діаметру»).");
        Require(v["wall"] < Math.Min(v["radiusX"], v["radiusZ"]), "Товщина стінки має бути меншою за радіус.");
        double c = n / 2.0, h = c - t;
        return Fit(r => Plan(n, m, n, (i, _, k) => Math.Min(Layer(i, n), Layer(k, n)) < t, p =>
        {
            double x = p.X - c, z = p.Z - c, rInf = Math.Max(Math.Abs(x), Math.Abs(z));
            double f = Math.Clamp((rInf - h) / t, 0, 1), len = Math.Sqrt(x * x + z * z);
            double dx = len < 1e-12 ? 0 : x / len, dz = len < 1e-12 ? 0 : z / len;
            double yt = p.Y / m, s = (1 + (v["topScale"] - 1) * yt) * (1 + (Ridge2(x / c, z / c, n, r) - 1) * f);
            double rx = (v["radiusX"] - v["wall"] + f * v["wall"]) * s, rz = (v["radiusZ"] - v["wall"] + f * v["wall"]) * s;
            return new Vec3(c + rx * dx, v["height"] * yt, c + rz * dz);
        }));
    });

    private static TemplateKind Sphere() => new("sphere", "Куля / еліпсоїд", "Кулі", new[]
    {
        P("around", "Кубів по діаметру", 6, 2, 10, true),
        P("radiusX", "Піввісь X", 1, 0.01, 1000), P("radiusY", "Піввісь Y", 1, 0.01, 1000), P("radiusZ", "Піввісь Z", 1, 0.01, 1000),
    }, v => Fit(r => SphereBody(v, 0, false, r)));

    private static TemplateKind HollowSphere() => new("hollow-sphere", "Порожня куля (оболонка)", "Кулі", new[]
    {
        P("around", "Кубів по діаметру", 8, 4, 16, true), P("wallCells", "Стінка, кубів", 1, 1, 8, true),
        P("radiusX", "Зовнішня піввісь X", 1, 0.01, 1000), P("radiusY", "Зовнішня піввісь Y", 1, 0.01, 1000), P("radiusZ", "Зовнішня піввісь Z", 1, 0.01, 1000),
        P("wall", "Товщина оболонки", 0.2, 0.001, 1000),
    }, v => Fit(r => SphereBody(v, v.Int("wallCells"), false, r)));

    private static TemplateKind Hemisphere() => new("hemisphere", "Напівкуля (купол)", "Кулі", new[]
    {
        P("around", "Кубів по діаметру (парне)", 6, 2, 10, true), P("wallCells", "Стінка, кубів (0 = суцільна)", 0, 0, 8, true),
        P("radiusX", "Піввісь X", 1, 0.01, 1000), P("radiusY", "Висота купола", 1, 0.01, 1000), P("radiusZ", "Піввісь Z", 1, 0.01, 1000),
        P("wall", "Товщина оболонки", 0.2, 0.001, 1000),
    }, v => Fit(r => SphereBody(v, v.Int("wallCells"), true, r)));

    // A ball (or its upper half) built from an n-wide cube of cells; with wallCells > 0 only the outer
    // layers stay, and the radius runs from the inner surface to the outer one across them.
    private static BodyPlan SphereBody(TemplateValues v, int t, bool half, Rounding rounding)
    {
        int n = v.Int("around");
        if (half && n % 2 == 1) n++;
        double c = n / 2.0;
        int ny = half ? n / 2 : n;
        double wall = t > 0 ? v["wall"] : 0;
        if (t > 0)
        {
            Require(2 * t < n, "Стінка у кубах занадто товста: у кулі має лишитись порожнина (збільште «кубів по діаметру»).");
            Require(wall < Math.Min(v["radiusX"], Math.Min(v["radiusY"], v["radiusZ"])), "Товщина оболонки має бути меншою за піввісь.");
        }
        double h = c - t;
        return Plan(n, ny, n,
            (i, j, k) => t == 0 || Math.Min(Layer(i, n), Math.Min(half ? ny - 1 - j : Layer(j, ny), Layer(k, n))) < t,   // a dome is open at the bottom
            p =>
            {
                double x = p.X - c, y = half ? p.Y : p.Y - c, z = p.Z - c;
                double rInf = Math.Max(Math.Abs(x), Math.Max(Math.Abs(y), Math.Abs(z)));
                var d = Ball(x / c, y / c, z / c, n, rounding);
                double len = Math.Sqrt(x * x + y * y + z * z);
                if (t == 0) return new Vec3(c + v["radiusX"] * d.X, (half ? 0 : c) + v["radiusY"] * d.Y, c + v["radiusZ"] * d.Z);
                double f = Math.Clamp((rInf - h) / t, 0, 1);
                double ux = len < 1e-12 ? 0 : x / len, uy = len < 1e-12 ? 0 : y / len, uz = len < 1e-12 ? 0 : z / len;
                double push = 1 + (Ridge3(x / c, y / c, z / c, n, rounding) - 1) * f;
                return new Vec3(
                    c + (v["radiusX"] - wall + f * wall) * ux * push,
                    (half ? 0 : c) + (v["radiusY"] - wall + f * wall) * uy * push,
                    c + (v["radiusZ"] - wall + f * wall) * uz * push);
            });
    }

    private static TemplateKind Torus() => new("torus", "Тор (бублик)", "Кільця", new[]
    {
        P("around", "Кубів по зовнішньому діаметру", 16, 4, 40, true), P("tubeCells", "Кубів у перерізі труби (1–2)", 2, 1, 2, true),
        P("ringRadius", "Радіус кільця", 2, 0.01, 1000), P("tubeRadius", "Радіус труби", 0.6, 0.001, 1000),
    }, v =>
    {
        int n = v.Int("around"), t = v.Int("tubeCells");
        Require(n - 2 * t >= 1, "Переріз труби завеликий для кільця: збільште «кубів по зовнішньому діаметру».");
        Require(v["tubeRadius"] < v["ringRadius"], "Радіус труби має бути меншим за радіус кільця.");
        double c = n / 2.0, h = c - t;
        BodyPlan Torus(Rounding ring, Rounding sectionRounding) => Plan(n, t, n, (i, _, k) => Math.Min(Layer(i, n), Layer(k, n)) < t, p =>
        {
            double x = p.X - c, z = p.Z - c, rInf = Math.Max(Math.Abs(x), Math.Abs(z)), len = Math.Sqrt(x * x + z * z);
            double dx = len < 1e-12 ? 0 : x / len, dz = len < 1e-12 ? 0 : z / len;
            var section = Disc(2 * Math.Clamp((rInf - h) / t, 0, 1) - 1, 2 * p.Y / t - 1, t, sectionRounding);
            double rho = (v["ringRadius"] + v["tubeRadius"] * section.X) * (1 + (Ridge2(x / c, z / c, n, ring) - 1) * Math.Clamp((rInf - h) / t, 0, 1));
            return new Vec3(c + rho * dx, v["tubeRadius"] * (1 + section.Y), c + rho * dz);
        });
        // The tube's own cross-section (a few cubes across) needs a much stronger push than the big ring does, and
        // the ring should not be bent for the section's sake: find the section's push first with the ring pushed
        // generously, then the weakest ring push that still works with it.
        var generous = new Rounding(1, 2, 0, 1);
        var (sectionFit, _) = FitWith(r => Torus(generous, r));
        return Fit(r => Torus(r, sectionFit));
    });

    private static TemplateKind PlateWithHole() => new("plate-hole", "Пластина з круглим отвором", "Кільця", new[]
    {
        P("around", "Кубів по стороні", 8, 4, 40, true), P("wallCells", "Кубів навколо отвору", 2, 1, 10, true), P("layers", "Шарів по висоті", 1, 1, 10, true),
        P("size", "Сторона пластини", 4, 0.01, 1000), P("holeRadius", "Радіус отвору", 0.8, 0.001, 1000), P("thickness", "Товщина", 0.3, 0.001, 1000),
    }, v =>
    {
        int n = v.Int("around"), t = v.Int("wallCells"), layers = v.Int("layers");
        Require(n - 2 * t >= 1, "Навколо отвору забагато кубів: має лишитись хоч один куб отвору (збільште «кубів по стороні»).");
        Require(v["holeRadius"] < v["size"] / 2, "Отвір має бути меншим за половину сторони пластини.");
        double c = n / 2.0, h = c - t;
        return Plan(n, layers, n, (i, _, k) => Math.Min(Layer(i, n), Layer(k, n)) < t, p =>
        {
            double x = p.X - c, z = p.Z - c, rInf = Math.Max(Math.Abs(x), Math.Abs(z)), len = Math.Sqrt(x * x + z * z);
            double f = Math.Clamp((rInf - h) / t, 0, 1);
            double dx = len < 1e-12 ? 0 : x / len, dz = len < 1e-12 ? 0 : z / len;
            // along each ray from the hole's edge out to the plate's square edge
            double edge = v["size"] / 2 / Math.Max(Math.Abs(dx), Math.Abs(dz)), radius = v["holeRadius"] + f * (edge - v["holeRadius"]);
            return new Vec3(c + radius * dx, p.Y / layers * v["thickness"], c + radius * dz);
        });
    });

    // The profiles keep square cells of a given size: only which cells exist differs.
    private static BodyPlan Profile(int nx, int ny, int nz, double cell, Func<int, int, bool> keep) =>
        Plan(nx, ny, nz, (i, j, _) => keep(i, j), p => new Vec3(p.X * cell, p.Y * cell, p.Z * cell));

    private static TemplateKind LProfile() => new("l-profile", "Кутик (L)", "Профілі", new[]
    {
        P("armX", "Горизонтальна полиця, кубів", 5, 2, 40, true), P("armY", "Вертикальна полиця, кубів", 5, 2, 40, true),
        P("thick", "Товщина полиці, кубів", 1, 1, 10, true), P("depth", "Довжина, кубів", 3, 1, 40, true), P("cell", "Розмір куба", 1, 0.01, 100),
    }, v =>
    {
        int ax = v.Int("armX"), ay = v.Int("armY"), t = v.Int("thick");
        Require(t < Math.Min(ax, ay), "Товщина має бути меншою за обидві полиці.");
        return Profile(ax, ay, v.Int("depth"), v["cell"], (i, j) => i < t || j < t);
    });

    private static TemplateKind TProfile() => new("t-profile", "Тавр (T)", "Профілі", new[]
    {
        P("width", "Полиця, кубів", 7, 3, 40, true), P("height", "Висота, кубів", 6, 2, 40, true),
        P("thick", "Товщина, кубів", 1, 1, 10, true), P("depth", "Довжина, кубів", 3, 1, 40, true), P("cell", "Розмір куба", 1, 0.01, 100),
    }, v =>
    {
        int w = v.Int("width"), h = v.Int("height"), t = v.Int("thick");
        Require(t < w && t < h, "Товщина має бути меншою за ширину і висоту.");
        int stem = (w - t) / 2;
        return Profile(w, h, v.Int("depth"), v["cell"], (i, j) => j >= h - t || (i >= stem && i < stem + t));
    });

    private static TemplateKind UProfile() => new("u-profile", "Швелер (U)", "Профілі", new[]
    {
        P("width", "Ширина, кубів", 6, 3, 40, true), P("height", "Висота, кубів", 6, 2, 40, true),
        P("thick", "Товщина, кубів", 1, 1, 10, true), P("depth", "Довжина, кубів", 3, 1, 40, true), P("cell", "Розмір куба", 1, 0.01, 100),
    }, v =>
    {
        int w = v.Int("width"), h = v.Int("height"), t = v.Int("thick");
        Require(2 * t < w && t < h, "Стінки занадто товсті для такої ширини/висоти.");
        return Profile(w, h, v.Int("depth"), v["cell"], (i, j) => j < t || i < t || i >= w - t);
    });

    private static TemplateKind Cross() => new("cross", "Хрест", "Профілі", new[]
    {
        P("arm", "Довжина променя, кубів", 3, 1, 20, true), P("thick", "Товщина, кубів", 1, 1, 10, true),
        P("depth", "Довжина, кубів", 2, 1, 40, true), P("cell", "Розмір куба", 1, 0.01, 100),
    }, v =>
    {
        int a = v.Int("arm"), t = v.Int("thick"), size = 2 * a + t;
        return Profile(size, size, v.Int("depth"), v["cell"], (i, j) => (i >= a && i < a + t) || (j >= a && j < a + t));
    });

    private static TemplateKind Stairs() => new("stairs", "Сходи", "Профілі", new[]
    {
        P("steps", "Сходинок", 4, 2, 30, true), P("depth", "Ширина, кубів", 3, 1, 40, true), P("cell", "Розмір куба", 1, 0.01, 100),
    }, v =>
    {
        int s = v.Int("steps");
        return Profile(s, s, v.Int("depth"), v["cell"], (i, j) => j <= i);
    });

    // ---------------------------------------------------------------------------------------
    // presets

    private static TemplatePreset Preset(string name, string label, string kind, params (string Key, double Value)[] values) =>
        new(name, label, kind, values.ToDictionary(x => x.Key, x => x.Value));

    private static IReadOnlyList<TemplatePreset> BuildPresets() => new[]
    {
        Preset("beam-3x2x2", "Брус 3×2×2", "block"),
        Preset("cube-2", "Куб 2×2×2", "block", ("countX", 2), ("countY", 2), ("countZ", 2), ("length", 2), ("height", 2), ("depth", 2)),
        Preset("column", "Колона 1×6×1", "block", ("countX", 1), ("countY", 6), ("countZ", 1), ("length", 1), ("height", 6), ("depth", 1)),
        Preset("slab", "Плита 6×1×6", "block", ("countX", 6), ("countY", 1), ("countZ", 6), ("length", 6), ("height", 0.5), ("depth", 6)),
        Preset("wall", "Стіна 8×4×1", "block", ("countX", 8), ("countY", 4), ("countZ", 1), ("length", 8), ("height", 4), ("depth", 0.5)),
        Preset("box", "Порожня коробка", "box-shell"),
        Preset("box-thick", "Коробка з товстою стінкою", "box-shell", ("countX", 7), ("countY", 6), ("countZ", 7), ("wallCells", 2), ("length", 7), ("height", 6), ("depth", 7)),
        Preset("cylinder", "Циліндр", "cylinder"),
        Preset("rod", "Стрижень (тонкий)", "cylinder", ("around", 4), ("along", 8), ("radiusX", 0.3), ("radiusZ", 0.3), ("height", 4)),
        Preset("disk", "Диск", "cylinder", ("around", 8), ("along", 1), ("radiusX", 2), ("radiusZ", 2), ("height", 0.3)),
        Preset("cylinder-elliptic", "Еліптичний циліндр", "cylinder", ("radiusX", 1.5), ("radiusZ", 0.8)),
        Preset("cone", "Конус", "cylinder", ("topScale", 0.1)),
        Preset("frustum", "Зрізаний конус", "cylinder", ("topScale", 0.5)),
        Preset("pipe", "Труба", "pipe"),
        Preset("pipe-thick", "Товстостінна труба", "pipe", ("wallCells", 2), ("wall", 0.5), ("around", 10)),
        Preset("pipe-long", "Довга труба", "pipe", ("along", 12), ("height", 8)),
        Preset("pipe-short", "Кільце (коротка труба)", "pipe", ("along", 1), ("height", 0.6), ("wall", 0.3)),
        Preset("pipe-elliptic", "Еліптична труба", "pipe", ("radiusX", 1.6), ("radiusZ", 0.9)),
        Preset("pipe-cone", "Конічна труба", "pipe", ("topScale", 0.5)),
        Preset("sphere", "Куля", "sphere"),
        Preset("sphere-fine", "Куля (густа сітка)", "sphere", ("around", 10)),
        Preset("ellipsoid-flat", "Сплюснутий еліпсоїд", "sphere", ("radiusX", 1.5), ("radiusY", 0.6), ("radiusZ", 1.5)),
        Preset("ellipsoid-long", "Витягнутий еліпсоїд", "sphere", ("radiusX", 2), ("radiusY", 0.8), ("radiusZ", 0.8)),
        Preset("hollow-sphere", "Порожня куля", "hollow-sphere"),
        Preset("hollow-ellipsoid", "Порожній еліпсоїд", "hollow-sphere", ("radiusX", 1.6), ("radiusY", 1), ("radiusZ", 1)),
        Preset("hemisphere", "Напівкуля", "hemisphere"),
        Preset("dome", "Купол (оболонка)", "hemisphere", ("around", 8), ("wallCells", 1)),
        Preset("torus", "Тор", "torus"),
        Preset("torus-thin", "Тонкий тор", "torus", ("around", 20), ("tubeCells", 1), ("tubeRadius", 0.3), ("ringRadius", 2.5)),
        Preset("plate-hole", "Пластина з отвором", "plate-hole"),
        Preset("washer", "Шайба", "plate-hole", ("around", 8), ("wallCells", 3), ("size", 3), ("holeRadius", 0.6), ("thickness", 0.2)),
        Preset("l-profile", "Кутик", "l-profile"),
        Preset("t-profile", "Тавр", "t-profile"),
        Preset("u-profile", "Швелер", "u-profile"),
        Preset("cross", "Хрест", "cross"),
        Preset("stairs", "Сходи", "stairs"),
    };
}
