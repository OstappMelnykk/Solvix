using Solvix.Contracts.Facades;
using Solvix.FemMesh;
using Solvix.FemMesh.Local;
using Solvix.Solver.Selections;

namespace Solvix.Solver;

/// <summary>One face of one small element on the outside of a cube: the cube, the side, and the cell (p, q) of that side's n1 x n2 grid
/// (p along the lower axis of the face's two tangent axes, q along the higher).</summary>
internal readonly record struct SubFace(int Hex, string Face, int P, int Q);

/// <summary>One small element of a divided cube: the cube and the element's index along each of its axes.</summary>
internal readonly record struct ElementKey(int Hex, int Ex, int Ey, int Ez);

/// <summary>
/// What the user has set up for one session: a library of materials, which cube and which part of a cube has which, and the faces that are clamped or pressed.
/// Plain data keyed by editor hex ids; a stale id (a deleted cube) is harmless and is dropped by <see cref="Prune"/>.
/// <para>
/// Everything finer than a cube is stored as REGIONS of the cube in the cube's own coordinates (a rectangle on a side, a box inside), not as cells of a division and
/// not as elements of any mesh. A region means the same place whatever the body is cut into: the mesh binds it to its own faces and elements (<see cref="SetupBinding"/>),
/// so changing the division, or refining locally, changes no selection - the same regions simply cover more or fewer elements. The old way of speaking (a cell
/// (p, q) or (ex, ey, ez) of the current division) is kept at the edge: a request names cells, they become regions, and the lists handed out name the cells whose centre
/// lies in a region.
/// </para>
/// </summary>
internal sealed class SolverSetup
{
    private readonly Dictionary<string, SolverMaterialDto> _materials = Materials.Presets.ToDictionary(m => m.Name);
    private readonly Dictionary<int, string> _hexMaterials = new();
    private readonly Dictionary<int, RegionMap<string>> _elementMaterials = new();
    private readonly Dictionary<(int Hex, string Side), RegionMap<bool>> _fixed = new();
    private readonly Dictionary<(int Hex, string Side), RegionMap<double>> _loads = new();
    private List<RefinementStep> _refinements = new();

    public int Version { get; private set; }
    public string DefaultMaterial { get; private set; } = Materials.DefaultName;

    public const int MaxDivision = 8;
    public (int Nx, int Ny, int Nz) Divisions { get; private set; } = (1, 1, 1);

    public IReadOnlyDictionary<string, SolverMaterialDto> MaterialsByName => _materials;
    public IReadOnlyDictionary<int, string> HexMaterials => _hexMaterials;

    /// <summary>The local refinement, one step after another (empty: the cubes are cut evenly by <see cref="Divisions"/>).</summary>
    public IReadOnlyList<RefinementStep> Refinements => _refinements;

    /// <summary>The rule that turns the cubes into the mesh of finite elements: the local refinement when there is one, else the even cut.</summary>
    public IMeshRefinement Rule() => _refinements.Count > 0 ? new LocalRefinement(_refinements) : new UniformRefinement(Divisions.Nx, Divisions.Ny, Divisions.Nz);

    /// <summary>The cells of the current division that have a material of their own (the cell whose centre lies in a region).</summary>
    public IReadOnlyDictionary<ElementKey, string> ElementMaterials
    {
        get
        {
            var result = new Dictionary<ElementKey, string>();
            foreach (var (hex, map) in _elementMaterials)
                for (int ex = 0; ex < Divisions.Nx; ex++)
                    for (int ey = 0; ey < Divisions.Ny; ey++)
                        for (int ez = 0; ez < Divisions.Nz; ez++)
                        {
                            var key = new ElementKey(hex, ex, ey, ez);
                            if (map.TryGetValueAt(Centre(SetupBinding.RegionOf(key, Counts)), out var name)) result[key] = name;
                        }
            return result;
        }
    }

    /// <summary>The cells of the current division that are clamped (the cell whose centre lies in a clamped region).</summary>
    public IReadOnlyCollection<SubFace> Fixed => CellsOf(_fixed).Select(c => c.Face).ToList();

    /// <summary>The cells of the current division that are pressed, and how hard.</summary>
    public IReadOnlyDictionary<SubFace, double> Loads => CellsOf(_loads).ToDictionary(c => c.Face, c => c.Value);

    private int[] Counts => new[] { Divisions.Nx, Divisions.Ny, Divisions.Nz };

    private static ParametricPoint Centre(ParametricRegion r) => new(0.5 * (r.X0 + r.X1), 0.5 * (r.Y0 + r.Y1), 0.5 * (r.Z0 + r.Z1));

    private IEnumerable<(SubFace Face, T Value)> CellsOf<T>(Dictionary<(int Hex, string Side), RegionMap<T>> maps) where T : notnull
    {
        foreach (var ((hex, side), map) in maps)
        {
            var (t0, t1) = Tangents(side);
            for (int p = 0; p < Counts[t0]; p++)
                for (int q = 0; q < Counts[t1]; q++)
                    if (map.TryGetValueAt(Centre(SetupBinding.RegionOf(side, p, q, Counts)), out var value)) yield return (new SubFace(hex, side, p, q), value);
        }
    }

    // ---- what the mesh asks: for a place in a cube, what is set there --------------------------------------------

    /// <summary>The material of the part of a cube that holds a place: its own region's, else its cube's, else the default one.</summary>
    public string MaterialAt(int hex, ParametricPoint at) =>
        _elementMaterials.TryGetValue(hex, out var map) && map.TryGetValueAt(at, out var name) && _materials.ContainsKey(name) ? name : MaterialOf(hex);

    /// <summary>Whether the face whose centre is at a place on a side of a cube is clamped.</summary>
    public bool IsFixedAt(int hex, string side, ParametricPoint at) => _fixed.TryGetValue((hex, side), out var map) && map.TryGetValueAt(at, out _);

    /// <summary>The pressure on the face whose centre is at a place on a side of a cube, if any.</summary>
    public double? LoadAt(int hex, string side, ParametricPoint at) => _loads.TryGetValue((hex, side), out var map) && map.TryGetValueAt(at, out double p) ? p : null;

    public bool HasFixed(int hex, string side) => _fixed.ContainsKey((hex, side));

    public bool HasLoads(int hex, string side) => _loads.ContainsKey((hex, side));

    // ---- history -----------------------------------------------------------------------------------

    private const int MaxHistory = 200;
    private readonly List<Snapshot> _undo = new();
    private readonly List<Snapshot> _redo = new();

    public bool CanUndo => _undo.Count > 0;
    public bool CanRedo => _redo.Count > 0;

    /// <summary>Everything the user can set here, as it was at one moment (the version is not part of it).</summary>
    private sealed record Snapshot(
        Dictionary<string, SolverMaterialDto> Materials, Dictionary<int, string> HexMaterials, Dictionary<int, RegionMap<string>> ElementMaterials,
        Dictionary<(int, string), RegionMap<bool>> Fixed, Dictionary<(int, string), RegionMap<double>> Loads, string DefaultMaterial, (int, int, int) Divisions,
        List<RefinementStep> Refinements)
    {
        public bool SameAs(Snapshot other) =>
            DefaultMaterial == other.DefaultMaterial && Divisions == other.Divisions && SameSteps(Refinements, other.Refinements)
            && SameMaps(Fixed, other.Fixed) && SameMaps(ElementMaterials, other.ElementMaterials) && SameMaps(Loads, other.Loads)
            && SameDictionary(HexMaterials, other.HexMaterials) && SameDictionary(Materials, other.Materials);

        private static bool SameSteps(List<RefinementStep> a, List<RefinementStep> b) =>
            a.Count == b.Count && a.Zip(b).All(p => p.First.NI == p.Second.NI && p.First.NJ == p.Second.NJ && p.First.NK == p.Second.NK
                && p.First.TransitionDepth == p.Second.TransitionDepth && p.First.Leaves.SequenceEqual(p.Second.Leaves));

        private static bool SameDictionary<TKey, TValue>(Dictionary<TKey, TValue> a, Dictionary<TKey, TValue> b) where TKey : notnull =>
            a.Count == b.Count && a.All(p => b.TryGetValue(p.Key, out var v) && EqualityComparer<TValue>.Default.Equals(p.Value, v));

        private static bool SameMaps<TKey, TValue>(Dictionary<TKey, RegionMap<TValue>> a, Dictionary<TKey, RegionMap<TValue>> b) where TKey : notnull where TValue : notnull =>
            a.Count == b.Count && a.All(p => b.TryGetValue(p.Key, out var m) && p.Value.SameAs(m));
    }

    private static Dictionary<TKey, RegionMap<TValue>> CopyMaps<TKey, TValue>(Dictionary<TKey, RegionMap<TValue>> maps) where TKey : notnull where TValue : notnull =>
        maps.ToDictionary(p => p.Key, p => p.Value.Copy());

    private Snapshot Take() => new(new(_materials), new(_hexMaterials), CopyMaps(_elementMaterials), CopyMaps(_fixed), CopyMaps(_loads), DefaultMaterial, Divisions, new(_refinements));

    private void Restore(Snapshot snapshot)
    {
        _materials.Clear();
        foreach (var (k, v) in snapshot.Materials) _materials[k] = v;
        _hexMaterials.Clear();
        foreach (var (k, v) in snapshot.HexMaterials) _hexMaterials[k] = v;
        _elementMaterials.Clear();
        foreach (var (k, v) in snapshot.ElementMaterials) _elementMaterials[k] = v.Copy();
        _fixed.Clear();
        foreach (var (k, v) in snapshot.Fixed) _fixed[k] = v.Copy();
        _loads.Clear();
        foreach (var (k, v) in snapshot.Loads) _loads[k] = v.Copy();
        DefaultMaterial = snapshot.DefaultMaterial;
        Divisions = snapshot.Divisions;
        _refinements = new(snapshot.Refinements);
        Version++;
    }

    // One user action: remembered for undo when it changed something (an action that changed nothing leaves no step).
    private void Edit(Action change)
    {
        var before = Take();
        int version = Version;
        change();
        if (Take().SameAs(before))
        {
            Version = version;                                           // nothing changed: nothing to tell anyone about
            return;
        }
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

    /// <summary>The material of a cell of a cube's grid: of the region that holds its centre, else of its cube.</summary>
    public string MaterialOf(ElementKey element) => MaterialAt(element.Hex, Centre(SetupBinding.RegionOf(element, Counts)));

    // ---- the division ------------------------------------------------------------------------------

    /// <summary>
    /// Changes the grid in whose cells requests and lists are put. Nothing that was set changes: it is stored as regions of the cube, which no grid owns; the new
    /// grid just names the cells whose centres lie in them.
    /// </summary>
    public bool SetDivisions(int nx, int ny, int nz)
    {
        if (new[] { nx, ny, nz }.Any(n => n < 1 || n > MaxDivision)) return false;
        Edit(() =>
        {
            // the even cut and the local refinement are two rules for one mesh: choosing the even cut drops the refinement
            if (Divisions == (nx, ny, nz) && _refinements.Count == 0) return;
            Divisions = (nx, ny, nz);
            _refinements = new();
            Version++;
        });
        return true;
    }

    // ---- the local refinement -----------------------------------------------------------------------

    /// <summary>Adds a local refinement to the end of the history. The even cut gives way to it (the division goes back to 1 x 1 x 1: what is set stays, as it is stored in regions).</summary>
    public void AddRefinement(RefinementStep step) => Edit(() =>
    {
        Divisions = (1, 1, 1);
        _refinements.Add(step);
        Version++;
    });

    /// <summary>Takes the whole local refinement away.</summary>
    public void ClearRefinements() => Edit(() =>
    {
        if (_refinements.Count == 0) return;
        _refinements = new();
        Version++;
    });

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
        foreach (var map in _elementMaterials.Values) map.RemoveValue(name);
        DropEmpty(_elementMaterials);
        Version++;
    });

    public void SetDefault(string name) => Edit(() =>
    {
        DefaultMaterial = name;
        Version++;
    });

    /// <summary>Gives whole cubes a material (what was given to parts of them goes back to following it).</summary>
    public void SetMaterial(IEnumerable<int> hexes, string? name) => Edit(() =>
    {
        var set = hexes.ToHashSet();
        foreach (int hex in set)
        {
            if (string.IsNullOrEmpty(name) || name == DefaultMaterial) _hexMaterials.Remove(hex);
            else _hexMaterials[hex] = name;
            _elementMaterials.Remove(hex);
        }
        Version++;
    });

    /// <summary>Gives cells of a cube's grid a material of their own (null or empty: they follow their cube again).</summary>
    public void SetElementMaterial(IEnumerable<ElementKey> elements, string? name) => Edit(() =>
    {
        foreach (var element in elements.Where(IsValidElement)) SetMaterialOn(element.Hex, new BoxShape(Cuboid.Of(SetupBinding.RegionOf(element, Counts))), name);
        Version++;
    });

    /// <summary>Gives a shape of a cube (a place in its own coordinates) a material of its own (null or empty: it follows the cube again).</summary>
    public void SetMaterialOn(int hex, Shape region, string? name)
    {
        if (!_elementMaterials.TryGetValue(hex, out var map)) _elementMaterials[hex] = map = new RegionMap<string>();
        if (string.IsNullOrEmpty(name) || name == MaterialOf(hex)) map.Clear(region);
        else map.Set(region, name);
        if (map.Count == 0) _elementMaterials.Remove(hex);
    }

    /// <summary>Gives the places of elements a material of their own (null or empty: they follow their cube again); all of it is one step to undo.</summary>
    public void SetMaterialsOn(IEnumerable<(int Hex, Shape Shape)> elements, string? name) => Edit(() =>
    {
        foreach (var (hex, shape) in elements) SetMaterialOn(hex, shape, name);
        Version++;
    });

    // ---- faces -------------------------------------------------------------------------------------

    private static Shape CellBox(SubFace f, int[] counts) => new BoxShape(Cuboid.Of(SetupBinding.RegionOf(f.Face, f.P, f.Q, counts)));

    private static RegionMap<T> MapOf<T>(Dictionary<(int Hex, string Side), RegionMap<T>> maps, int hex, string side) where T : notnull =>
        maps.TryGetValue((hex, side), out var map) ? map : maps[(hex, side)] = new RegionMap<T>();

    private static void DropEmpty<TKey, TValue>(Dictionary<TKey, RegionMap<TValue>> maps) where TKey : notnull where TValue : notnull
    {
        foreach (var key in maps.Where(m => m.Value.Count == 0).Select(m => m.Key).ToList()) maps.Remove(key);
    }

    public void SetFixed(IEnumerable<SubFace> faces, bool isFixed) => Edit(() =>
    {
        foreach (var face in faces)
        {
            var map = MapOf(_fixed, face.Hex, face.Face);
            if (isFixed) map.Set(CellBox(face, Counts), true);
            else map.Clear(CellBox(face, Counts));
        }
        DropEmpty(_fixed);
        Version++;
    });

    /// <summary>Clamps (or unclamps) the places of faces on sides of cubes, all of it one step to undo.</summary>
    public void SetFixedOn(IEnumerable<(int Hex, string Side, Shape Shape)> faces, bool isFixed) => Edit(() =>
    {
        foreach (var (hex, side, shape) in faces)
        {
            var map = MapOf(_fixed, hex, side);
            if (isFixed) map.Set(shape, true);
            else map.Clear(shape);
        }
        DropEmpty(_fixed);
        Version++;
    });

    /// <summary>Presses (or, with nothing, clears the pressure of) the places of faces on sides of cubes, all of it one step to undo.</summary>
    public void SetLoadsOn(IEnumerable<(int Hex, string Side, Shape Shape)> faces, double? pressure) => Edit(() =>
    {
        foreach (var (hex, side, shape) in faces)
        {
            var map = MapOf(_loads, hex, side);
            if (pressure is double p) map.Set(shape, p);
            else map.Clear(shape);
        }
        DropEmpty(_loads);
        Version++;
    });

    public void ReplaceFixed(IEnumerable<SubFace> faces) => Edit(() =>
    {
        var list = faces.ToList();
        _fixed.Clear();
        foreach (var face in list) MapOf(_fixed, face.Hex, face.Face).Set(CellBox(face, Counts), true);
        Version++;
    });

    public void ReplaceLoads(IEnumerable<SubFace> faces, double pressure) => Edit(() =>
    {
        var list = faces.ToList();
        _loads.Clear();
        foreach (var face in list) MapOf(_loads, face.Hex, face.Face).Set(CellBox(face, Counts), pressure);
        Version++;
    });

    public void SetLoads(IEnumerable<SubFace> faces, double? pressure) => Edit(() =>
    {
        foreach (var face in faces)
        {
            var map = MapOf(_loads, face.Hex, face.Face);
            if (pressure is double p) map.Set(CellBox(face, Counts), p);
            else map.Clear(CellBox(face, Counts));
        }
        DropEmpty(_loads);
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
        foreach (int hex in _elementMaterials.Keys.Where(h => !alive.Contains(h)).ToList()) { _elementMaterials.Remove(hex); changed = true; }
        foreach (var key in _fixed.Keys.Where(k => !alive.Contains(k.Hex)).ToList()) { _fixed.Remove(key); changed = true; }
        foreach (var key in _loads.Keys.Where(k => !alive.Contains(k.Hex)).ToList()) { _loads.Remove(key); changed = true; }
        if (changed) Version++;
    }

    public SolverSetupDto ToDto()
    {
        var fixedNow = Fixed;
        var loadsNow = Loads;
        var elementMaterials = ElementMaterials;
        return new(
            Version,
            new[] { Divisions.Nx, Divisions.Ny, Divisions.Nz },
            _materials.Values.ToList(),
            DefaultMaterial,
            new Dictionary<int, string>(_hexMaterials),
            elementMaterials.OrderBy(m => m.Key.Hex).ThenBy(m => m.Key.Ez).ThenBy(m => m.Key.Ey).ThenBy(m => m.Key.Ex)
                .Select(m => new SolverElementMaterialDto(m.Key.Hex, m.Key.Ex, m.Key.Ey, m.Key.Ez, m.Value)).ToList(),
            fixedNow.OrderBy(f => f.Hex).ThenBy(f => f.Face).ThenBy(f => f.P).ThenBy(f => f.Q).Select(f => new SolverFaceDto(f.Hex, f.Face, f.P, f.Q)).ToList(),
            loadsNow.OrderBy(l => l.Key.Hex).ThenBy(l => l.Key.Face).ThenBy(l => l.Key.P).ThenBy(l => l.Key.Q)
                .Select(l => new SolverLoadDto(l.Key.Hex, l.Key.Face, l.Value, l.Key.P, l.Key.Q)).ToList(),
            CanUndo, CanRedo,
            _refinements.Count == 0 ? null : _refinements.Select(r => new RefinementStepDto(r.Leaves.ToList(), r.NI, r.NJ, r.NK, r.TransitionDepth)).ToList());
    }
}
