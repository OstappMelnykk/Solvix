namespace Solvix.Mesh;

/// <summary>What a smoothing run found and did.</summary>
/// <param name="Interior">Interior corner nodes that were free to move.</param>
/// <param name="Surface">Surface corner nodes that were free to slide (0 unless surface smoothing was asked for).</param>
/// <param name="Moved">How many of them moved at least once.</param>
/// <param name="Corners">All the corner nodes of the mesh (the others are frozen on the surface, a ridge or a corner).</param>
/// <param name="MaxMove">The largest distance any corner node ended up from where it started.</param>
/// <param name="MeanMove">The mean of that distance over the corner nodes that were free.</param>
public readonly record struct SmoothReport(int Interior, int Surface, int Moved, int Corners = 0, double MaxMove = 0, double MeanMove = 0);

public sealed partial class HexMesh
{
    /// <summary>
    /// Laplacian smoothing in 3D. Interior corner nodes (all their faces linked to a neighbour) move freely; the midpoints
    /// of the edges that leave a moved corner follow it by half, as when the corner is dragged. With
    /// <paramref name="surface"/> the corner nodes on the outer surface slide too, but only within their tangent plane
    /// and only where the surface is smooth there (its normals agree within <paramref name="featureAngle"/>): ridges, cusps and corners
    /// of the body stay, so its shape is kept.
    ///
    /// A plain Laplacian pulls a node to the average of its neighbours, which evens out the spacing and so thins a
    /// finely meshed region. Here the neighbours are weighted by 1 / (edge length): along a line of nodes every spacing
    /// is then a fixed point (the weighted average of the two neighbours is the node itself), so the local density of
    /// the mesh stays as it was and only the sideways irregularity - skew, bent lines - is relaxed. A surface node
    /// looks at its neighbours along the surface only.
    ///
    /// A step that would fold or degenerate a hex around the node is halved up to four times, and dropped if it still
    /// does.
    /// </summary>
    /// <param name="density">How strongly the local density is kept, 0..1: the neighbour weight is 1 / length^density, so 1 keeps
    /// the spacing as it is (the default) and 0 is the plain Laplacian that evens the spacing out.</param>
    /// <param name="featureAngle">Degrees: the surface normals at a node may differ by this much and the node still slides.</param>
    public SmoothReport Smooth(int iterations, double relaxation = 0.5, bool surface = false, double density = 1, double featureAngle = 25)
    {
        double flatCosine = Math.Cos(featureAngle * Math.PI / 180);
        var free = new List<(int Id, List<int> Neighbours, bool OnSurface)>();
        foreach (int id in InteriorCornerNodes()) free.Add((id, CornerNeighbours(id, surfaceOnly: false), false));
        int interior = free.Count;
        if (surface)
            foreach (int id in FlatSurfaceCornerNodes(flatCosine)) free.Add((id, CornerNeighbours(id, surfaceOnly: true), true));
        var start = free.ToDictionary(f => f.Id, f => _nodes[f.Id].Position);
        var moved = new HashSet<int>();
        for (int iteration = 0; iteration < iterations; iteration++)
        {
            foreach (var (id, neighbours, onSurface) in free)
            {
                var node = _nodes[id];
                double weight = 0;
                Vec3 sum = Vec3.Zero;
                foreach (int other in neighbours)
                {
                    var p = _nodes[other].Position;
                    double length = (p - node.Position).Length;
                    if (length <= 1e-12) continue;
                    double w = density == 0 ? 1 : Math.Pow(length, -density);
                    weight += w;
                    sum += p * w;
                }
                if (weight <= 0) continue;
                var step = (sum * (1 / weight) - node.Position) * relaxation;
                if (onSurface)
                {
                    var normal = SurfaceNormal(id);
                    if (normal is null) continue;
                    step -= normal.Value * Dot(step, normal.Value);        // slide along the surface, never off it
                }
                if (step.Length <= 1e-12) continue;
                if (TryMoveKeepingValid(id, step)) moved.Add(id);
            }
        }
        var travelled = free.Select(f => (_nodes[f.Id].Position - start[f.Id]).Length).ToList();
        int corners = _owners.Count(o => o.Value.All(x => Hex20Reference.IsCorner(x.Slot)));
        return new SmoothReport(interior, free.Count - interior, moved.Count, corners, travelled.Count > 0 ? travelled.Max() : 0, travelled.Count > 0 ? travelled.Average() : 0);
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

    // the faces of a hex that contain a corner slot
    private static IEnumerable<HexFace> FacesAt(int slot) =>
        HexFaces.All.Where(f => Hex20Reference.LocalCoords[slot, f.Axis()] == f.Sign());

    // corner nodes all of whose faces (in every hex that owns them) are linked to a neighbour
    private List<int> InteriorCornerNodes()
    {
        var result = new List<int>();
        foreach (var (id, owners) in _owners)
        {
            if (!owners.All(o => Hex20Reference.IsCorner(o.Slot))) continue;
            if (owners.All(o => FacesAt(o.Slot).All(f => Neighbor(o.Hex, f) is not null))) result.Add(id);
        }
        result.Sort();
        return result;
    }

    // surface corner nodes on a smooth patch of the surface: the outward normals of the surface faces there agree
    private List<int> FlatSurfaceCornerNodes(double flatCosine)
    {
        var result = new List<int>();
        foreach (var (id, owners) in _owners)
        {
            if (!owners.All(o => Hex20Reference.IsCorner(o.Slot))) continue;
            var normals = SurfaceNormals(id);
            if (normals.Count == 0) continue;                       // interior
            bool flat = true;
            foreach (var a in normals)
                foreach (var b in normals)
                    if (Dot(a, b) < flatCosine) flat = false;
            if (flat) result.Add(id);
        }
        result.Sort();
        return result;
    }

    // the outward unit normal of every surface face at the node
    private List<Vec3> SurfaceNormals(int nodeId)
    {
        var normals = new List<Vec3>();
        foreach (var (hexId, slot) in _owners[nodeId])
        {
            var hex = _hexes[hexId];
            var xi = new Vec3(Hex20Reference.LocalCoords[slot, 0], Hex20Reference.LocalCoords[slot, 1], Hex20Reference.LocalCoords[slot, 2]);
            var j = hex.Jacobian(xi);
            Vec3 Column(int c) => new(j[0, c], j[1, c], j[2, c]);
            foreach (var face in FacesAt(slot))
            {
                if (Neighbor(hexId, face) is not null) continue;
                int axis = face.Axis();
                var n = Cross(Column((axis + 1) % 3), Column((axis + 2) % 3));
                if (Dot(n, Column(axis) * face.Sign()) < 0) n = n * -1;
                if (n.Length > 1e-12) normals.Add(n * (1 / n.Length));
            }
        }
        return normals;
    }

    private Vec3? SurfaceNormal(int nodeId)
    {
        var sum = SurfaceNormals(nodeId).Aggregate(Vec3.Zero, (a, b) => a + b);
        return sum.Length > 1e-12 ? sum * (1 / sum.Length) : null;
    }

    // the corner nodes joined to this one by an edge of any hex (with surfaceOnly: by an edge that lies on the surface)
    private List<int> CornerNeighbours(int nodeId, bool surfaceOnly)
    {
        var set = new HashSet<int>();
        foreach (var (hexId, slot) in _owners[nodeId])
            foreach (var (a, b) in Hex20Reference.EdgeCorners)
            {
                if (a != slot && b != slot) continue;
                if (surfaceOnly && !EdgeOnSurface(hexId, a, b)) continue;
                set.Add(_hexes[hexId].NodeIds[a == slot ? b : a]);
            }
        return set.ToList();
    }

    // an edge lies on the surface if one of the two faces of the hex that share it has no neighbour
    private bool EdgeOnSurface(int hexId, int a, int b) =>
        HexFaces.All.Any(f => Hex20Reference.LocalCoords[a, f.Axis()] == f.Sign() && Hex20Reference.LocalCoords[b, f.Axis()] == f.Sign() && Neighbor(hexId, f) is null);

    private static double Dot(Vec3 a, Vec3 b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;
    private static Vec3 Cross(Vec3 a, Vec3 b) => new(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X);
}
