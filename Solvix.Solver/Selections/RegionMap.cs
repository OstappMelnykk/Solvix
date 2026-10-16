using Solvix.FemMesh;

namespace Solvix.Solver.Selections;

/// <summary>
/// What is set on the regions of one cube (or of one side of it): each region of a cube has at most one value, regions never overlap. Setting a value on a box
/// takes that box out of whatever was there; clearing takes it out for good. A box that is already exactly so changes nothing (so an action that changes nothing
/// can be told). This is the part of the setup that does NOT depend on how the body is cut into elements: the mesh asks, for each of its faces or elements, which
/// region it lies in (<see cref="ValueAt"/>), so a region means the same on an even cut, a locally refined mesh, or any other.
/// </summary>
internal sealed class RegionMap<TValue> where TValue : notnull
{
    private readonly List<(Cuboid Box, TValue Value)> _entries = new();

    public IReadOnlyList<(Cuboid Box, TValue Value)> Entries => _entries;

    public int Count => _entries.Count;

    public RegionMap<TValue> Copy()
    {
        var copy = new RegionMap<TValue>();
        copy._entries.AddRange(_entries);
        return copy;
    }

    /// <summary>Puts a value on the box, taking the box out of whatever was there. Returns whether anything changed.</summary>
    public bool Set(Cuboid box, TValue value) => Replace(box, value, true);

    /// <summary>Takes the box out: nothing is set on it afterwards. Returns whether anything changed.</summary>
    public bool Clear(Cuboid box) => Replace(box, default, false);

    private bool Replace(Cuboid box, TValue? value, bool has)
    {
        if (has ? Covered(box, value!) : !_entries.Any(e => e.Box.Overlaps(box))) return false;

        var kept = new List<(Cuboid, TValue)>();
        foreach (var (existing, v) in _entries)
        {
            if (!existing.Overlaps(box)) kept.Add((existing, v));
            else foreach (var piece in existing.Minus(box)) kept.Add((piece, v));
        }
        if (has) kept.Add((box, value!));
        _entries.Clear();
        _entries.AddRange(kept);
        Coalesce();
        return true;
    }

    /// <summary>Whether the two maps set the same values on the same places, however each has cut its regions up.</summary>
    public bool SameAs(RegionMap<TValue> other) =>
        _entries.All(e => other.Covered(e.Box, e.Value)) && other._entries.All(e => Covered(e.Box, e.Value));

    /// <summary>Takes every region with this value out (the value itself is gone, say a material that was deleted). Returns whether anything changed.</summary>
    public bool RemoveValue(TValue value) => _entries.RemoveAll(e => EqualityComparer<TValue>.Default.Equals(e.Value, value)) > 0;

    /// <summary>The value of the region that owns a place, or nothing.</summary>
    public bool TryGetValueAt(ParametricPoint point, out TValue value)
    {
        foreach (var (box, v) in _entries)
            if (box.Owns(point)) { value = v; return true; }
        value = default!;
        return false;
    }

    /// <summary>Whether every part of the box already has this value.</summary>
    private bool Covered(Cuboid box, TValue value)
    {
        var uncovered = new List<Cuboid> { box };
        foreach (var (existing, v) in _entries)
        {
            if (!EqualityComparer<TValue>.Default.Equals(v, value)) continue;
            uncovered = uncovered.SelectMany(u => u.Minus(existing)).ToList();
            if (uncovered.Count == 0) return true;
        }
        return uncovered.Count == 0;
    }

    // Two boxes with the same value that fill a bigger box between them become that box, so a region that was cut and put back together is one box again.
    private void Coalesce()
    {
        if (_entries.Count > 4000) return;                                       // the work is quadratic; a map this fragmented is left as it is
        bool merged = true;
        while (merged)
        {
            merged = false;
            for (int i = 0; i < _entries.Count && !merged; i++)
                for (int j = i + 1; j < _entries.Count && !merged; j++)
                    if (EqualityComparer<TValue>.Default.Equals(_entries[i].Value, _entries[j].Value) && TryJoin(_entries[i].Box, _entries[j].Box, out var joined))
                    {
                        _entries[i] = (joined, _entries[i].Value);
                        _entries.RemoveAt(j);
                        merged = true;
                    }
        }
    }

    private static bool TryJoin(Cuboid a, Cuboid b, out Cuboid joined)
    {
        joined = a;
        int different = -1;
        for (int axis = 0; axis < 3; axis++)
        {
            if (a.Lo(axis) == b.Lo(axis) && a.Hi(axis) == b.Hi(axis)) continue;
            if (different >= 0) return false;
            different = axis;
        }
        if (different < 0) return false;
        if (a.Hi(different) == b.Lo(different)) { joined = a.With(different, a.Lo(different), b.Hi(different)); return true; }
        if (b.Hi(different) == a.Lo(different)) { joined = a.With(different, b.Lo(different), a.Hi(different)); return true; }
        return false;
    }
}
