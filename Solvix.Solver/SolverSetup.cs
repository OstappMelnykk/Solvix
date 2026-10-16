using Solvix.Contracts.Facades;

namespace Solvix.Solver;

/// <summary>One face of one small element on the outside of a cube: the cube, the side, and the cell (p, q) of that side's n1 x n2 grid
/// (p along the lower axis of the face's two tangent axes, q along the higher).</summary>
internal readonly record struct SubFace(int Hex, string Face, int P, int Q);

/// <summary>One small element of a divided cube: the cube and the element's index along each of its axes.</summary>
internal readonly record struct ElementKey(int Hex, int Ex, int Ey, int Ez);

/// <summary>
/// What the user has set up for one session: a library of materials, which cube and which small element has which,
/// and the small faces that are clamped or pressed. Plain data keyed by editor hex ids; a stale id (a deleted cube)
/// is harmless and is dropped by <see cref="Prune"/>. Everything finer than a cube is stored for the current division,
/// and follows a change of the division: a selected region stays the same region, cut into more (or fewer) cells.
/// </summary>
internal sealed class SolverSetup
{
    private readonly Dictionary<string, SolverMaterialDto> _materials = Materials.Presets.ToDictionary(m => m.Name);
    private readonly Dictionary<int, string> _hexMaterials = new();
    private readonly Dictionary<ElementKey, string> _elementMaterials = new();
    private readonly HashSet<SubFace> _fixed = new();
    private readonly Dictionary<SubFace, double> _loads = new();

    public int Version { get; private set; }
    public string DefaultMaterial { get; private set; } = Materials.DefaultName;

    public const int MaxDivision = 8;
    public (int Nx, int Ny, int Nz) Divisions { get; private set; } = (1, 1, 1);

    public IReadOnlyDictionary<string, SolverMaterialDto> MaterialsByName => _materials;
    public IReadOnlyDictionary<int, string> HexMaterials => _hexMaterials;
    public IReadOnlyDictionary<ElementKey, string> ElementMaterials => _elementMaterials;
    public IReadOnlyCollection<SubFace> Fixed => _fixed;
    public IReadOnlyDictionary<SubFace, double> Loads => _loads;

    private int[] Counts => new[] { Divisions.Nx, Divisions.Ny, Divisions.Nz };

    // ---- history -----------------------------------------------------------------------------------

    private const int MaxHistory = 200;
    private readonly List<Snapshot> _undo = new();
    private readonly List<Snapshot> _redo = new();

    public bool CanUndo => _undo.Count > 0;
    public bool CanRedo => _redo.Count > 0;

    /// <summary>Everything the user can set here, as it was at one moment (the version is not part of it).</summary>
    private sealed record Snapshot(
        Dictionary<string, SolverMaterialDto> Materials, Dictionary<int, string> HexMaterials, Dictionary<ElementKey, string> ElementMaterials,
        HashSet<SubFace> Fixed, Dictionary<SubFace, double> Loads, string DefaultMaterial, (int, int, int) Divisions)
    {
        public bool SameAs(Snapshot other) =>
            DefaultMaterial == other.DefaultMaterial && Divisions == other.Divisions
            && Fixed.SetEquals(other.Fixed)
            && SameDictionary(HexMaterials, other.HexMaterials) && SameDictionary(ElementMaterials, other.ElementMaterials)
            && SameDictionary(Loads, other.Loads) && SameDictionary(Materials, other.Materials);

        private static bool SameDictionary<TKey, TValue>(Dictionary<TKey, TValue> a, Dictionary<TKey, TValue> b) where TKey : notnull =>
            a.Count == b.Count && a.All(p => b.TryGetValue(p.Key, out var v) && EqualityComparer<TValue>.Default.Equals(p.Value, v));
    }

    private Snapshot Take() => new(new(_materials), new(_hexMaterials), new(_elementMaterials), new(_fixed), new(_loads), DefaultMaterial, Divisions);

    private void Restore(Snapshot snapshot)
    {
        _materials.Clear();
        foreach (var (k, v) in snapshot.Materials) _materials[k] = v;
        _hexMaterials.Clear();
        foreach (var (k, v) in snapshot.HexMaterials) _hexMaterials[k] = v;
        _elementMaterials.Clear();
        foreach (var (k, v) in snapshot.ElementMaterials) _elementMaterials[k] = v;
        _fixed.Clear();
        foreach (var f in snapshot.Fixed) _fixed.Add(f);
        _loads.Clear();
        foreach (var (k, v) in snapshot.Loads) _loads[k] = v;
        DefaultMaterial = snapshot.DefaultMaterial;
        Divisions = snapshot.Divisions;
        Version++;
    }

    // One user action: remembered for undo when it changed something (an action that changed nothing leaves no step).
    private void Edit(Action change)
    {
        var before = Take();
        change();
        if (Take().SameAs(before)) return;
        _undo.Add(before);
        if (_undo.Count > MaxHistory) _undo.RemoveAt(0);
        _redo.Clear();
    }

    public bool Undo()
    {
        if (_undo.Count == 0) return false;
        _redo.Add(Take());
        var snapshot = _undo[^1];
        _undo.RemoveAt(_undo.Count - 1);
        Restore(snapshot);
        return true;
    }

    public bool Redo()
    {
        if (_redo.Count == 0) return false;
        _undo.Add(Take());
        var snapshot = _redo[^1];
        _redo.RemoveAt(_redo.Count - 1);
        Restore(snapshot);
        return true;
    }

    private static int AxisOf(string face) => face[0] - 'X';

    // The two tangent axes of a face, lower first.
    private static (int, int) Tangents(string face)
    {
        int a = AxisOf(face);
        var t = Enumerable.Range(0, 3).Where(d => d != a).ToArray();
        return (t[0], t[1]);
    }

    /// <summary>The small faces a request names: one cell when (p, q) is given and inside the grid, the whole side of the cube otherwise.</summary>
    public IEnumerable<SubFace> Expand(int hex, string face, int? p, int? q)
    {
        var (t0, t1) = Tangents(face);
        int n0 = Counts[t0], n1 = Counts[t1];
        if (p is int pp && q is int qq)
        {
            if (pp >= 0 && pp < n0 && qq >= 0 && qq < n1) yield return new SubFace(hex, face, pp, qq);
            yield break;
        }
        for (int i = 0; i < n0; i++)
            for (int j = 0; j < n1; j++) yield return new SubFace(hex, face, i, j);
    }

    public bool IsValidElement(ElementKey e) => e.Ex >= 0 && e.Ex < Divisions.Nx && e.Ey >= 0 && e.Ey < Divisions.Ny && e.Ez >= 0 && e.Ez < Divisions.Nz;

    public string MaterialOf(int hex) => _hexMaterials.TryGetValue(hex, out var name) && _materials.ContainsKey(name) ? name : DefaultMaterial;

    public string MaterialOf(ElementKey element) =>
        _elementMaterials.TryGetValue(element, out var name) && _materials.ContainsKey(name) ? name : MaterialOf(element.Hex);

    // ---- the division ------------------------------------------------------------------------------

    public bool SetDivisions(int nx, int ny, int nz)
    {
        if (new[] { nx, ny, nz }.Any(n => n < 1 || n > MaxDivision)) return false;
        Edit(() => ApplyDivisions(nx, ny, nz));
        return true;
    }

    private void ApplyDivisions(int nx, int ny, int nz)
    {
        var before = Counts;
        var after = new[] { nx, ny, nz };
        if (before.SequenceEqual(after)) return;

        // regions follow the new grid: a new cell belongs to an old one when its centre lies inside it
        var fixedNow = _fixed.SelectMany(f => RemapFace(f, before, after)).ToList();
        var loadsNow = _loads.SelectMany(l => RemapFace(l.Key, before, after).Select(f => (f, l.Value))).ToList();
        var elementsNow = _elementMaterials.SelectMany(m => RemapElement(m.Key, before, after).Select(e => (e, m.Value))).ToList();
        Divisions = (nx, ny, nz);
        _fixed.Clear();
        foreach (var f in fixedNow) _fixed.Add(f);
        _loads.Clear();
        foreach (var (f, pressure) in loadsNow) _loads[f] = pressure;
        _elementMaterials.Clear();
        foreach (var (e, name) in elementsNow) _elementMaterials[e] = name;
        Version++;
    }

    // Indices of a new grid of n2 cells whose centre falls into cell `index` of a grid of n1 cells.
    private static IEnumerable<int> Inside(int index, int n1, int n2) =>
        Enumerable.Range(0, n2).Where(j => (int)Math.Floor((j + 0.5) / n2 * n1) == index);

    private static IEnumerable<SubFace> RemapFace(SubFace f, int[] before, int[] after)
    {
        var (t0, t1) = Tangents(f.Face);
        foreach (int p in Inside(f.P, before[t0], after[t0]))
            foreach (int q in Inside(f.Q, before[t1], after[t1])) yield return f with { P = p, Q = q };
    }

    private static IEnumerable<ElementKey> RemapElement(ElementKey e, int[] before, int[] after)
    {
        foreach (int x in Inside(e.Ex, before[0], after[0]))
            foreach (int y in Inside(e.Ey, before[1], after[1]))
                foreach (int z in Inside(e.Ez, before[2], after[2])) yield return e with { Ex = x, Ey = y, Ez = z };
    }

    // ---- materials ---------------------------------------------------------------------------------

    public void Upsert(SolverMaterialDto material) => Edit(() =>
    {
        _materials[material.Name] = material;
        Version++;
    });

    /// <summary>Removes a material from the library: what had it goes back to the default one. The default material cannot be removed.</summary>
    public void Remove(string name) => Edit(() =>
    {
        if (name == DefaultMaterial || !_materials.Remove(name)) return;
        foreach (int hex in _hexMaterials.Where(h => h.Value == name).Select(h => h.Key).ToList()) _hexMaterials.Remove(hex);
        foreach (var key in _elementMaterials.Where(e => e.Value == name).Select(e => e.Key).ToList()) _elementMaterials.Remove(key);
        Version++;
    });

    public void SetDefault(string name) => Edit(() =>
    {
        DefaultMaterial = name;
        Version++;
    });

    /// <summary>Gives whole cubes a material (their individual small elements go back to following it).</summary>
    public void SetMaterial(IEnumerable<int> hexes, string? name) => Edit(() =>
    {
        var set = hexes.ToHashSet();
        foreach (int hex in set)
        {
            if (string.IsNullOrEmpty(name) || name == DefaultMaterial) _hexMaterials.Remove(hex);
            else _hexMaterials[hex] = name;
        }
        foreach (var key in _elementMaterials.Keys.Where(k => set.Contains(k.Hex)).ToList()) _elementMaterials.Remove(key);
        Version++;
    });

    /// <summary>Gives small elements a material of their own (null or empty: they follow their cube again).</summary>
    public void SetElementMaterial(IEnumerable<ElementKey> elements, string? name) => Edit(() =>
    {
        foreach (var element in elements.Where(IsValidElement))
        {
            if (string.IsNullOrEmpty(name) || name == MaterialOf(element.Hex)) _elementMaterials.Remove(element);
            else _elementMaterials[element] = name;
        }
        Version++;
    });

    // ---- faces -------------------------------------------------------------------------------------

    public void SetFixed(IEnumerable<SubFace> faces, bool isFixed) => Edit(() =>
    {
        foreach (var face in faces)
        {
            if (isFixed) _fixed.Add(face);
            else _fixed.Remove(face);
        }
        Version++;
    });

    public void ReplaceFixed(IEnumerable<SubFace> faces) => Edit(() =>
    {
        var list = faces.ToList();
        _fixed.Clear();
        foreach (var face in list) _fixed.Add(face);
        Version++;
    });

    public void ReplaceLoads(IEnumerable<SubFace> faces, double pressure) => Edit(() =>
    {
        var list = faces.ToList();
        _loads.Clear();
        foreach (var face in list) _loads[face] = pressure;
        Version++;
    });

    public void SetLoads(IEnumerable<SubFace> faces, double? pressure) => Edit(() =>
    {
        foreach (var face in faces)
        {
            if (pressure is double p) _loads[face] = p;
            else _loads.Remove(face);
        }
        Version++;
    });

    public void Clear() => Edit(() =>
    {
        _hexMaterials.Clear();
        _elementMaterials.Clear();
        _fixed.Clear();
        _loads.Clear();
        Version++;
    });

    public void Prune(IReadOnlyCollection<int> existing)
    {
        var alive = existing as ISet<int> ?? new HashSet<int>(existing);
        bool changed = false;
        foreach (int hex in _hexMaterials.Keys.Where(h => !alive.Contains(h)).ToList()) { _hexMaterials.Remove(hex); changed = true; }
        foreach (var key in _elementMaterials.Keys.Where(k => !alive.Contains(k.Hex)).ToList()) { _elementMaterials.Remove(key); changed = true; }
        changed |= _fixed.RemoveWhere(f => !alive.Contains(f.Hex)) > 0;
        foreach (var key in _loads.Keys.Where(k => !alive.Contains(k.Hex)).ToList()) { _loads.Remove(key); changed = true; }
        if (changed) Version++;
    }

    public SolverSetupDto ToDto() => new(
        Version,
        new[] { Divisions.Nx, Divisions.Ny, Divisions.Nz },
        _materials.Values.ToList(),
        DefaultMaterial,
        new Dictionary<int, string>(_hexMaterials),
        _elementMaterials.OrderBy(m => m.Key.Hex).ThenBy(m => m.Key.Ez).ThenBy(m => m.Key.Ey).ThenBy(m => m.Key.Ex)
            .Select(m => new SolverElementMaterialDto(m.Key.Hex, m.Key.Ex, m.Key.Ey, m.Key.Ez, m.Value)).ToList(),
        _fixed.OrderBy(f => f.Hex).ThenBy(f => f.Face).ThenBy(f => f.P).ThenBy(f => f.Q).Select(f => new SolverFaceDto(f.Hex, f.Face, f.P, f.Q)).ToList(),
        _loads.OrderBy(l => l.Key.Hex).ThenBy(l => l.Key.Face).ThenBy(l => l.Key.P).ThenBy(l => l.Key.Q)
            .Select(l => new SolverLoadDto(l.Key.Hex, l.Key.Face, l.Value, l.Key.P, l.Key.Q)).ToList(),
        CanUndo, CanRedo);
}
