namespace Solvix.Mesh;

public sealed partial class HexMesh
{
    /// <summary>
    /// Laplacian smoothing of the interior of the body, in 3D. Only interior corner nodes move (a node that touches a
    /// face with no neighbour is on the boundary and stays: the outer shape is not changed), and the midpoints of the
    /// edges that leave a moved corner follow it by half, as when the corner is dragged.
    ///
    /// A plain Laplacian pulls a node to the average of its neighbours, which evens out the spacing and so thins a
    /// finely meshed region. Here the neighbours are weighted by 1 / (edge length): along a line of nodes every spacing
    /// is then a fixed point (the weighted average of the two neighbours is the node itself), so the local density of
    /// the mesh stays as it was and only the sideways irregularity - skew, bent lines - is relaxed.
    ///
    /// A step that would fold or degenerate a hex around the node is halved up to four times, and dropped if it still
    /// does. Returns how many nodes moved at least once.
    /// </summary>
    public int Smooth(int iterations, double relaxation = 0.5)
    {
        var movable = InteriorCornerNodes();
        var neighbours = movable.ToDictionary(id => id, CornerNeighbours);
        var moved = new HashSet<int>();
        for (int iteration = 0; iteration < iterations; iteration++)
        {
            foreach (int id in movable)
            {
                var node = _nodes[id];
                double weight = 0;
                Vec3 sum = Vec3.Zero;
                foreach (int other in neighbours[id])
                {
                    var p = _nodes[other].Position;
                    double length = (p - node.Position).Length;
                    if (length <= 1e-12) continue;
                    double w = 1 / length;
                    weight += w;
                    sum += p * w;
                }
                if (weight <= 0) continue;
                var step = (sum * (1 / weight) - node.Position) * relaxation;
                if (step.Length <= 1e-12) continue;
                if (TryMoveKeepingValid(id, step)) moved.Add(id);
            }
        }
        return moved.Count;
    }

    // moves the corner by `step` (its edge midpoints by half), keeping the hexes around it valid
    private bool TryMoveKeepingValid(int nodeId, Vec3 step)
    {
        var start = _nodes[nodeId].Position;
        var snapshot = new Dictionary<int, Vec3>();
        foreach (var (hexId, _) in _owners[nodeId])
            foreach (int id in _hexes[hexId].NodeIds) snapshot[id] = _nodes[id].Position;
        for (int attempt = 0; attempt < 5; attempt++, step *= 0.5)
        {
            DragNode(nodeId, start + step);
            if (_owners[nodeId].All(o => _hexes[o.Hex].IsValid())) return true;
            foreach (var (id, p) in snapshot) _nodes[id].Position = p;
        }
        return false;
    }

    // corner nodes all of whose faces (in every hex that owns them) are linked to a neighbour
    private List<int> InteriorCornerNodes()
    {
        var result = new List<int>();
        foreach (var (id, owners) in _owners)
        {
            if (!owners.All(o => Hex20Reference.IsCorner(o.Slot))) continue;
            bool interior = true;
            foreach (var (hexId, slot) in owners)
            {
                foreach (var face in HexFaces.All)
                {
                    if (Hex20Reference.LocalCoords[slot, face.Axis()] != face.Sign()) continue;
                    if (Neighbor(hexId, face) is null) interior = false;
                }
            }
            if (interior) result.Add(id);
        }
        result.Sort();
        return result;
    }

    // the corner nodes joined to this one by an edge of any hex
    private List<int> CornerNeighbours(int nodeId)
    {
        var set = new HashSet<int>();
        foreach (var (hexId, slot) in _owners[nodeId])
            foreach (var (a, b) in Hex20Reference.EdgeCorners)
            {
                if (a == slot) set.Add(_hexes[hexId].NodeIds[b]);
                else if (b == slot) set.Add(_hexes[hexId].NodeIds[a]);
            }
        return set.ToList();
    }
}
