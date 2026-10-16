using Solvix.Contracts.Facades;

namespace Solvix.Solver;

/// <summary>Everything that would make a solve meaningless or impossible, checked before it starts.</summary>
internal static class SolverValidator
{
    public const int MaxElements = 20_000;

    public static SolverValidationDto Validate(SolverSetup setup, FemMeshDto mesh)
    {
        var issues = new List<SolverIssueDto>();
        void Error(string message) => issues.Add(new SolverIssueDto("error", message));
        void Warning(string message) => issues.Add(new SolverIssueDto("warning", message));

        if (mesh.ElementCount == 0)
        {
            Error("Немає жодного куба.");
            return new SolverValidationDto(false, issues);
        }
        // how many elements the rule would make: an even cut is counted before anything is built, a refinement has to be replayed to know
        BuiltMesh? built = null;
        int elements;
        if (setup.Refinements.Count == 0)
        {
            elements = mesh.ElementCount * setup.Divisions.Nx * setup.Divisions.Ny * setup.Divisions.Nz;
            if (elements > MaxElements) Error($"Забагато елементів для розрахунку: {elements} ({mesh.ElementCount} кубів × {setup.Divisions.Nx * setup.Divisions.Ny * setup.Divisions.Nz}; ліміт {MaxElements}). Зменште поділ або кількість кубів.");
            else built = SolverMeshes.Build(setup, mesh);
        }
        else
        {
            try { built = SolverMeshes.Build(setup, mesh); }
            catch (Exception exception) when (exception is InvalidOperationException or ArgumentException)
            {
                Error($"Локальне згущення не вдалося: {exception.Message}");
                return new SolverValidationDto(false, issues);
            }
            elements = built.Mesh.ElementCount;
            if (elements > MaxElements)
            {
                Error($"Забагато елементів для розрахунку: {elements} (ліміт {MaxElements}). Приберіть частину згущення або зменште кількість кубів.");
                built = null;
            }
        }

        var alive = new HashSet<int>(mesh.ElementIds);
        if (mesh.FoldedHexes.Count > 0)
            Warning($"Вивернуті або вироджені куби (розрахунок біля них може бути хибним або не запуститися): {string.Join(", ", mesh.FoldedHexes.Take(12))}{(mesh.FoldedHexes.Count > 12 ? "…" : "")}.");

        // what the setup means on this mesh: which material each element has, which faces are clamped and which are pressed
        var problem = built is null ? null : SolverFacade.BuildInput(setup, mesh, built);
        var used = problem is null
            ? new List<string> { setup.DefaultMaterial }
            : problem.Model.Materials.Select(m => m.Name).Distinct().ToList();
        foreach (var name in used)
        {
            if (!setup.MaterialsByName.TryGetValue(name, out var material)) { Error($"Невідомий матеріал «{name}»."); continue; }
            var materialProblem = Materials.Problem(material);
            if (materialProblem is not null) Error(materialProblem);
        }

        // elements that can be integrated but badly, and materials so different that the iterative solve struggles
        var quality = built is null ? null : MeshQuality.Evaluate(setup, mesh, built.Mesh).Profiles.First(p => p.Id == "solvix");
        int invalid = quality?.Grades["invalid"] ?? 0;
        if (invalid > 0 && mesh.FoldedHexes.Count == 0)
            Warning($"{invalid} малих елементів вивернуті або вироджені після поділу кубів: розрахунок біля них може бути хибним або не запуститися. Перегляньте їх у Quality World.");
        int poor = quality?.Grades["poor"] ?? 0;
        if (quality is not null && poor > 0) Warning($"{poor} елементів не проходять критерії якості Solvix (найгірше: {Worst(quality)}): напруження біля них будуть неточними.");
        var moduli = used.Where(setup.MaterialsByName.ContainsKey).Select(n => setup.MaterialsByName[n].E).ToList();
        if (moduli.Count > 1 && moduli.Max() / moduli.Min() > 1e4)
            Warning($"Жорсткості матеріалів відрізняються у {moduli.Max() / moduli.Min():0e0} разів: ітераційний розв'язок може збігатися повільно або не збігтися.");

        // what the setup says about cubes that are gone
        int stale = setup.Fixed.Count(f => !alive.Contains(f.Hex)) + setup.Loads.Count(l => !alive.Contains(l.Key.Hex));
        if (stale > 0) Warning($"{stale} закріплень/навантажень посилаються на видалені куби й будуть проігноровані.");

        var clamped = problem?.Loads.Fixed ?? new List<Solvix.Fem.ElementFace>();
        var pressed = problem?.Loads.Pressures ?? new List<Solvix.Fem.FacePressure>();
        if (built is not null || problem is not null)
        {
            if (clamped.Count == 0) Error("Закріпіть хоча б одну грань: без опори тіло не має єдиного розв'язку.");
            if (pressed.Count == 0) Warning("Немає навантаження: результат буде нульовим.");
            if (pressed.Any(l => !double.IsFinite(l.Pn))) Error("Тиск має бути скінченним числом.");
            var clampedSet = clamped.ToHashSet();
            if (pressed.Any(l => clampedSet.Contains(l.Face)))
                Warning("Деякі грані одночасно закріплені й навантажені: тиск на закріплених вузлах нічого не змінює.");
        }
        else if (setup.Fixed.Count == 0) Error("Закріпіть хоча б одну грань: без опори тіло не має єдиного розв'язку.");

        // every separate part needs a support of its own, or it can float away
        var parts = Parts(mesh);
        var supported = new HashSet<int>(clamped.Select(f => mesh.ElementIds[built!.Mesh.RootOf(f.Element)]));
        for (int i = 0; i < parts.Count; i++)
        {
            if (built is not null && !parts[i].Any(supported.Contains))
                Error($"Частина тіла {i + 1} із {parts.Count} (куби {string.Join(", ", parts[i].Take(6))}{(parts[i].Count > 6 ? "…" : "")}) не закріплена: закріпіть у ній грань.");
        }
        if (built is not null && parts.Count > 1 && parts.All(p => p.Any(supported.Contains))) Warning($"Тіло складається з {parts.Count} окремих частин; вони не взаємодіють.");

        return new SolverValidationDto(issues.All(i => i.Severity != "error"), issues);
    }

    // Groups of elements (editor hex ids) that share at least one node.
    private static List<List<int>> Parts(FemMeshDto mesh)
    {
        var parent = Enumerable.Range(0, mesh.ElementCount).ToArray();
        int Find(int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; }
        var owner = new Dictionary<int, int>();
        for (int e = 0; e < mesh.ElementCount; e++)
            for (int s = 0; s < 20; s++)
            {
                int node = mesh.Connectivity[e * 20 + s];
                if (owner.TryGetValue(node, out int other)) parent[Find(e)] = Find(other);
                else owner[node] = e;
            }
        return Enumerable.Range(0, mesh.ElementCount).GroupBy(Find).Select(g => g.Select(e => mesh.ElementIds[e]).OrderBy(h => h).ToList()).OrderBy(p => p[0]).ToList();
    }

    // the measures that are beyond their warning limit, with the worst value found: "Jacobian ratio 45, Aspect ratio 23"
    private static string Worst(SolverQualityDto quality) =>
        string.Join(", ", quality.Limits
            .Where(l => l.HigherIsBetter ? quality.Worst[l.Key] < l.Bounds[0] : quality.Worst[l.Key] > l.Bounds[0])
            .Select(l => $"{l.Tech} {(quality.Worst[l.Key] >= 1e6 ? "∞" : quality.Worst[l.Key].ToString("0.##", System.Globalization.CultureInfo.InvariantCulture))}{l.Unit}"));
}
