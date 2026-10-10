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
        int elements = mesh.ElementCount * setup.Divisions.Nx * setup.Divisions.Ny * setup.Divisions.Nz;
        if (elements > MaxElements) Error($"Забагато елементів для розрахунку: {elements} ({mesh.ElementCount} кубів × {setup.Divisions.Nx * setup.Divisions.Ny * setup.Divisions.Nz}; ліміт {MaxElements}). Зменште поділ або кількість кубів.");

        var alive = new HashSet<int>(mesh.ElementIds);
        if (mesh.FoldedHexes.Count > 0)
            Error($"Вивернуті або вироджені куби (виправте їх перед розрахунком): {string.Join(", ", mesh.FoldedHexes.Take(12))}{(mesh.FoldedHexes.Count > 12 ? "…" : "")}.");

        // materials in use
        var used = mesh.ElementIds.Select(setup.MaterialOf).Concat(setup.ElementMaterials.Where(m => alive.Contains(m.Key.Hex)).Select(m => setup.MaterialOf(m.Key))).Distinct().ToList();
        foreach (var name in used)
        {
            if (!setup.MaterialsByName.TryGetValue(name, out var material)) { Error($"Невідомий матеріал «{name}»."); continue; }
            var problem = Materials.Problem(material);
            if (problem is not null) Error(problem);
        }

        // elements that can be integrated but badly, and materials so different that the iterative solve struggles
        var quality = elements > MaxElements ? null : MeshQuality.Evaluate(setup, mesh).Profiles.First(p => p.Id == "solvix");
        int poor = quality is null ? 0 : quality.Grades["poor"] + quality.Grades["invalid"];
        if (quality is not null && poor > 0) Warning($"{poor} елементів мають низьку якість (найгірша форма {quality.Worst["scaledJacobian"]:0.00}, кути {quality.Worst["minAngle"]:0}–{quality.Worst["maxAngle"]:0}°): напруження біля них будуть неточними.");
        var moduli = used.Where(setup.MaterialsByName.ContainsKey).Select(n => setup.MaterialsByName[n].E).ToList();
        if (moduli.Count > 1 && moduli.Max() / moduli.Min() > 1e4)
            Warning($"Жорсткості матеріалів відрізняються у {moduli.Max() / moduli.Min():0e0} разів: ітераційний розв'язок може збігатися повільно або не збігтися.");

        var fixedFaces = setup.Fixed.Where(f => alive.Contains(f.Hex) && SolverFaces.IsValid(f.Face)).ToList();
        var loads = setup.Loads.Where(l => alive.Contains(l.Key.Hex) && SolverFaces.IsValid(l.Key.Face)).ToList();
        int stale = setup.Fixed.Count + setup.Loads.Count - fixedFaces.Count - loads.Count;
        if (stale > 0) Warning($"{stale} закріплень/навантажень посилаються на видалені куби або невідомі грані й будуть проігноровані.");

        if (fixedFaces.Count == 0) Error("Закріпіть хоча б одну грань: без опори тіло не має єдиного розв'язку.");
        if (loads.Count == 0) Warning("Немає навантаження: результат буде нульовим.");
        if (loads.Any(l => !double.IsFinite(l.Value))) Error("Тиск має бути скінченним числом.");
        if (loads.Any(l => fixedFaces.Any(f => f == l.Key)))
            Warning("Деякі грані одночасно закріплені й навантажені: тиск на закріплених вузлах нічого не змінює.");

        // every separate part needs a support of its own, or it can float away
        var parts = Parts(mesh);
        var supported = new HashSet<int>(fixedFaces.Select(f => f.Hex));
        for (int i = 0; i < parts.Count; i++)
        {
            if (!parts[i].Any(supported.Contains))
                Error($"Частина тіла {i + 1} із {parts.Count} (куби {string.Join(", ", parts[i].Take(6))}{(parts[i].Count > 6 ? "…" : "")}) не закріплена: закріпіть у ній грань.");
        }
        if (parts.Count > 1 && parts.All(p => p.Any(supported.Contains))) Warning($"Тіло складається з {parts.Count} окремих частин; вони не взаємодіють.");

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
}
