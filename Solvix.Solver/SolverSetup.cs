using Solvix.Contracts.Facades;

namespace Solvix.Solver;

/// <summary>
/// What the user has set up for one session: a library of materials, which cube has which, and the faces
/// that are clamped or pressed. Plain data keyed by editor hex ids; a stale id (a deleted cube) is harmless
/// and is dropped by <see cref="Prune"/>.
/// </summary>
internal sealed class SolverSetup
{
    private readonly Dictionary<string, SolverMaterialDto> _materials = Materials.Presets.ToDictionary(m => m.Name);
    private readonly Dictionary<int, string> _hexMaterials = new();
    private readonly HashSet<(int Hex, string Face)> _fixed = new();
    private readonly Dictionary<(int Hex, string Face), double> _loads = new();

    public int Version { get; private set; }
    public string DefaultMaterial { get; private set; } = Materials.DefaultName;

    public IReadOnlyDictionary<string, SolverMaterialDto> MaterialsByName => _materials;
    public IReadOnlyDictionary<int, string> HexMaterials => _hexMaterials;
    public IReadOnlyCollection<(int Hex, string Face)> Fixed => _fixed;
    public IReadOnlyDictionary<(int Hex, string Face), double> Loads => _loads;

    public string MaterialOf(int hex) => _hexMaterials.TryGetValue(hex, out var name) && _materials.ContainsKey(name) ? name : DefaultMaterial;

    public void Upsert(SolverMaterialDto material)
    {
        _materials[material.Name] = material;
        Version++;
    }

    public void SetDefault(string name)
    {
        DefaultMaterial = name;
        Version++;
    }

    public void SetMaterial(IEnumerable<int> hexes, string? name)
    {
        foreach (int hex in hexes)
        {
            if (string.IsNullOrEmpty(name) || name == DefaultMaterial) _hexMaterials.Remove(hex);
            else _hexMaterials[hex] = name;
        }
        Version++;
    }

    public void SetFixed(IEnumerable<(int, string)> faces, bool isFixed)
    {
        foreach (var face in faces)
        {
            if (isFixed) _fixed.Add(face);
            else _fixed.Remove(face);
        }
        Version++;
    }

    public void SetLoads(IEnumerable<(int, string)> faces, double? pressure)
    {
        foreach (var face in faces)
        {
            if (pressure is double p) _loads[face] = p;
            else _loads.Remove(face);
        }
        Version++;
    }

    public void Clear()
    {
        _hexMaterials.Clear();
        _fixed.Clear();
        _loads.Clear();
        Version++;
    }

    public void Prune(IReadOnlyCollection<int> existing)
    {
        var alive = existing as ISet<int> ?? new HashSet<int>(existing);
        bool changed = false;
        foreach (int hex in _hexMaterials.Keys.Where(h => !alive.Contains(h)).ToList()) { _hexMaterials.Remove(hex); changed = true; }
        changed |= _fixed.RemoveWhere(f => !alive.Contains(f.Hex)) > 0;
        foreach (var key in _loads.Keys.Where(k => !alive.Contains(k.Hex)).ToList()) { _loads.Remove(key); changed = true; }
        if (changed) Version++;
    }

    public SolverSetupDto ToDto() => new(
        Version,
        _materials.Values.ToList(),
        DefaultMaterial,
        new Dictionary<int, string>(_hexMaterials),
        _fixed.OrderBy(f => f.Hex).ThenBy(f => f.Face).Select(f => new SolverFaceDto(f.Hex, f.Face)).ToList(),
        _loads.OrderBy(l => l.Key.Hex).ThenBy(l => l.Key.Face).Select(l => new SolverLoadDto(l.Key.Hex, l.Key.Face, l.Value)).ToList());
}
