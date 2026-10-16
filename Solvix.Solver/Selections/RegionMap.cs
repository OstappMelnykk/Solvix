using Solvix.FemMesh;

namespace Solvix.Solver.Selections;

/// <summary>
/// What is set on the places of one cube (or of one side of it): layers of shapes, the newest on top. What lies at a place is what the newest layer that
/// holds it says: a value, or (a layer that clears) nothing. Setting a value on a shape puts a layer on top; clearing puts a clearing layer on top. This is the
/// part of the setup that does NOT depend on how the body is cut into elements: the mesh asks, for each of its faces or elements, what lies at its centre
/// (<see cref="TryGetValueAt"/>), so a shape means the same on an even cut, a locally refined mesh, or any other.
/// <para>
/// A layer under a newer one of the very same shape is gone, so setting and clearing the same cell over and over does not pile up. Whether something changed is told
/// conservatively: only what is surely no change is called so (a box set to a value it already has everywhere is; a shape that is not a box is when the newest
/// layer there is the same shape with the same value) - at worst an action that changed nothing leaves a step to undo, never the reverse.
/// </para>
/// </summary>
internal sealed class RegionMap<TValue> where TValue : notnull
{
    private readonly record struct Layer(Shape Shape, bool Has, TValue? Value);

    private readonly List<Layer> _layers = new();

    public int Count => _layers.Count(l => l.Has);

    public RegionMap<TValue> Copy()
    {
        var copy = new RegionMap<TValue>();
        copy._layers.AddRange(_layers);
        return copy;
    }

    /// <summary>Puts a value on a shape. Returns whether anything changed.</summary>
    public bool Set(Shape shape, TValue value)
    {
        if (SurelyHas(shape, value)) return false;
        Push(new Layer(shape, true, value));
        return true;
    }

    /// <summary>Takes a shape's places out: nothing is set on them afterwards. Returns whether anything changed.</summary>
    public bool Clear(Shape shape)
    {
        if (!_layers.Any(l => l.Has && l.Shape.Bounds.Overlaps(shape.Bounds))) return false;
        Push(new Layer(shape, false, default));
        return true;
    }

    /// <summary>The value at a place, or nothing.</summary>
    public bool TryGetValueAt(ParametricPoint at, out TValue value)
    {
        for (int i = _layers.Count - 1; i >= 0; i--)
        {
            var layer = _layers[i];
            if (!Near(layer.Shape.Bounds, at) || !layer.Shape.Contains(at)) continue;
            if (!layer.Has) break;
            value = layer.Value!;
            return true;
        }
        value = default!;
        return false;
    }

    /// <summary>Whether the two maps are the same layers in the same order (a map put together differently that says the same may be called different, never the reverse).</summary>
    public bool SameAs(RegionMap<TValue> other) =>
        _layers.Count == other._layers.Count && _layers.Zip(other._layers).All(p =>
            p.First.Has == p.Second.Has && p.First.Shape.Equals(p.Second.Shape) && EqualityComparer<TValue>.Default.Equals(p.First.Value, p.Second.Value));

    /// <summary>Takes every layer with this value out (the value itself is gone, say a material that was deleted). Returns whether anything changed.</summary>
    public bool RemoveValue(TValue value) => _layers.RemoveAll(l => l.Has && EqualityComparer<TValue>.Default.Equals(l.Value, value)) > 0;

    private void Push(Layer layer)
    {
        _layers.RemoveAll(l => l.Shape.Equals(layer.Shape));              // under a newer layer of the very same shape: gone
        if (layer.Has || _layers.Any(l => l.Has && l.Shape.Bounds.Overlaps(layer.Shape.Bounds))) _layers.Add(layer);
    }

    private static bool Near(Cuboid bounds, ParametricPoint at)
    {
        // a flat shape (collapsed along an axis) is looked for everywhere on that axis: the face of an element is found by the centre of the face, which is on the plane
        for (int axis = 0; axis < 3; axis++)
        {
            if (bounds.Collapsed(axis)) continue;
            long c = Quantum.Of(at[axis]);
            if (c < bounds.Lo(axis) || c > bounds.Hi(axis)) return false;
        }
        return true;
    }

    // Surely every place of the shape already has this value.
    private bool SurelyHas(Shape shape, TValue value)
    {
        if (shape is BoxShape box) return BoxHas(box.Box, value);
        // not a box: only if the newest layer that touches it is that very shape with that value
        for (int i = _layers.Count - 1; i >= 0; i--)
        {
            var layer = _layers[i];
            if (!layer.Shape.Bounds.Overlaps(shape.Bounds)) continue;
            return layer.Has && layer.Shape.Equals(shape) && EqualityComparer<TValue>.Default.Equals(layer.Value, value);
        }
        return false;
    }

    // Exact for a box, as long as the layers over it are boxes too: the parts of the box that no layer has said anything about yet are what is left to look at.
    private bool BoxHas(Cuboid box, TValue value)
    {
        var rest = new List<Cuboid> { box };
        for (int i = _layers.Count - 1; i >= 0 && rest.Count > 0; i--)
        {
            var layer = _layers[i];
            if (!rest.Any(r => r.Overlaps(layer.Shape.Bounds)) && !layer.Shape.Bounds.Overlaps(box)) continue;
            if (layer.Shape is not BoxShape other)
            {
                if (layer.Shape.Bounds.Overlaps(box)) return false;                    // something that is not a box lies over it: not sure
                continue;
            }
            bool matches = layer.Has && EqualityComparer<TValue>.Default.Equals(layer.Value, value);
            var next = new List<Cuboid>();
            foreach (var part in rest)
            {
                if (!part.Overlaps(other.Box)) { next.Add(part); continue; }
                if (!matches) return false;                                              // a part of the box is held by something else
                next.AddRange(part.Minus(other.Box));
            }
            rest = next;
        }
        return rest.Count == 0;
    }
}
