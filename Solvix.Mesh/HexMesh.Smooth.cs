namespace Solvix.Mesh;

/// <summary>What a smoothing run found and did.</summary>
/// <param name="Interior">Interior corner nodes that were free to move.</param>
/// <param name="Surface">Surface corner nodes that were free to slide (0 unless surface smoothing was asked for).</param>
/// <param name="Moved">How many of them moved at least once.</param>
/// <param name="Corners">All the corner nodes of the mesh (the others are frozen on the surface, a ridge or a corner).</param>
/// <param name="MaxMove">The largest distance any corner node ended up from where it started.</param>
/// <param name="MeanMove">The mean of that distance over the corner nodes that were free.</param>
/// <param name="FoldedBefore">Cubes that were folded (negative or zero Jacobian) when smoothing began.</param>
/// <param name="FoldedAfter">... and how many are, when it ended.</param>
/// <param name="EdgesStraightened">Edge midpoints that were brought back towards the middle of their edge.</param>
/// <param name="Passes">The passes made: fewer than asked when the mesh stopped changing.</param>
/// <param name="Reshaped">Corner nodes of bad cubes that were moved in any direction within the shape tolerance (0 when it is off).</param>
public readonly record struct SmoothReport(int Interior, int Surface, int Moved, int Corners = 0, double MaxMove = 0, double MeanMove = 0, int FoldedBefore = 0, int FoldedAfter = 0, int EdgesStraightened = 0, int Passes = 0, int Reshaped = 0);

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
    /// <param name="shapeTolerance">A share of the local edge length (0 = off). The vertices of the cubes that are still bad when the passes are
    /// done - on ridges, corners and the surface included - are then moved in any direction, but never farther than this from
    /// where they were, as long as every step makes the cubes around them better. It reshapes the surface by that much: what the
    /// frozen ridge vertices of a round body need.</param>
    /// <param name="straighten">The midpoints of the edges are drawn back towards the middle of their edge (a straight edge): those
    /// of edges inside the body always, those on the surface only where a cube is folded (the surface is not reshaped). A
    /// bent midpoint is what folds a cube most often when the corners are in place.</param>
    /// <param name="untangle">The corner nodes of a folded cube are free to move in every direction, surface or not, and a step
    /// is taken when it makes the worst Jacobian around the node better even if the cubes there are still folded: that is
    /// what unfolds them. A folded cube cannot be solved, so this is what is wanted unless the surface must not change.</param>
    public SmoothReport Smooth(int iterations, double relaxation = 0.5, bool surface = false, double density = 1, double featureAngle = 25, bool untangle = true, bool straighten = true, double shapeTolerance = 0)
    {
        var quality = new CubeQuality(this);
        int foldedBefore = _hexes.Values.Count(h => !quality.Valid(h.Id));
        double flatCosine = Math.Cos(featureAngle * Math.PI / 180);
        var free = new List<(int Id, List<int> Neighbours, bool OnSurface)>();
        foreach (int id in InteriorCornerNodes()) free.Add((id, CornerNeighbours(id, surfaceOnly: false), false));
        int interior = free.Count;
        if (surface)
            foreach (int id in FlatSurfaceCornerNodes(flatCosine)) free.Add((id, CornerNeighbours(id, surfaceOnly: true), true));
        var interiorSet = free.Take(interior).Select(f => f.Id).ToHashSet();
        var foldedHexes = _hexes.Values.Where(h => !quality.Valid(h.Id)).Select(h => h.Id).ToHashSet();
        var tangled = new HashSet<int>();
        if (untangle)
        {
            foreach (int hexId in foldedHexes)
                for (int slot = 0; slot < Hex20Reference.CornerCount; slot++)
                {
                    int id = _hexes[hexId].NodeIds[slot];
                    if (!tangled.Add(id)) continue;
                    // a corner of a folded cube moves freely in 3D, looking at all its neighbours
                    int at = free.FindIndex(f => f.Id == id);
                    if (at >= 0) free[at] = (id, CornerNeighbours(id, surfaceOnly: false), false);
                    else free.Add((id, CornerNeighbours(id, surfaceOnly: false), false));
                }
        }
        var start = free.ToDictionary(f => f.Id, f => _nodes[f.Id].Position);
        var midpoints = straighten ? EdgeMidpoints(untangle ? foldedHexes : new HashSet<int>()) : new List<(int Id, int A, int B)>();
        var movedMid = new HashSet<int>();
        var moved = new HashSet<int>();
        // a pass that moves nothing by more than this ends the run: the mesh has settled
        var low = new Vec3(_nodes.Values.Min(n => n.Position.X), _nodes.Values.Min(n => n.Position.Y), _nodes.Values.Min(n => n.Position.Z));
        var high = new Vec3(_nodes.Values.Max(n => n.Position.X), _nodes.Values.Max(n => n.Position.Y), _nodes.Values.Max(n => n.Position.Z));
        double settled = 1e-9 * Math.Max(1e-9, (high - low).Length);
        // First the bent edges alone are straightened, until they settle: when the corners are in place that is all a folded
        // cube needs, and the corners then have nothing to untangle (they would otherwise be dragged about by the
        // Laplacian while cubes are still folded because of a bent edge).
        for (int round = 0; round < Math.Max(iterations, 50) && midpoints.Count > 0; round++)
        {
            double pulled = 0;
            foreach (var (id, a, b) in midpoints)
            {
                var pull = ((_nodes[a].Position + _nodes[b].Position) * 0.5 - _nodes[id].Position) * relaxation;
                if (pull.Length <= 1e-12) continue;
                if (TryMoveMidpoint(quality, id, pull, untangle)) { movedMid.Add(id); pulled = Math.Max(pulled, pull.Length); }
            }
            if (pulled < settled) break;
        }
        int passes = 0;
        // While a cube is folded the spacing of the nodes is only an accident of how it got folded, not a density worth keeping:
        // the passes then use the plain Laplacian (density 0), which also unties it best; then the density asked for is kept.
        bool folded = untangle && foldedBefore > 0;
        for (int iteration = 0; iteration < iterations; iteration++)
        {
            passes++;
            double largest = 0;
            // first the edges are straightened (a bent midpoint is what folds a cube most often), then the corners
            foreach (var (id, a, b) in midpoints)
            {
                var node = _nodes[id];
                var target = (_nodes[a].Position + _nodes[b].Position) * 0.5;
                var pull = (target - node.Position) * relaxation;
                if (pull.Length <= 1e-12) continue;
                if (TryMoveMidpoint(quality, id, pull, untangle)) { movedMid.Add(id); largest = Math.Max(largest, pull.Length); }
            }
            foreach (var (id, neighbours, onSurface) in free)
            {
                // a corner that is only free because its cube was folded moves only while a cube around it still is
                if (tangled.Contains(id) && !interiorSet.Contains(id) && quality.ValidAround(id)) continue;
                var node = _nodes[id];
                double weight = 0;
                Vec3 sum = Vec3.Zero;
                foreach (int other in neighbours)
                {
                    var p = _nodes[other].Position;
                    double length = (p - node.Position).Length;
                    if (length <= 1e-12) continue;
                    double w = density == 0 || folded ? 1 : Math.Pow(length, -density);
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
                if (TryMoveKeepingValid(quality, id, step, tangled.Contains(id))) { moved.Add(id); largest = Math.Max(largest, step.Length); }
            }
            if (folded) folded = _hexes.Values.Any(h => !quality.Valid(h.Id));
            else if (largest < settled) break;
        }
        int reshaped = shapeTolerance > 0 ? Reshape(quality, shapeTolerance, 40) : 0;
        var travelled = free.Select(f => (_nodes[f.Id].Position - start[f.Id]).Length).ToList();
        int corners = _owners.Count(o => o.Value.All(x => Hex20Reference.IsCorner(x.Slot)));
        return new SmoothReport(interior, free.Count - interior, moved.Count + movedMid.Count, corners, travelled.Count > 0 ? travelled.Max() : 0, travelled.Count > 0 ? travelled.Average() : 0,
            foldedBefore, _hexes.Values.Count(h => !quality.Valid(h.Id)), movedMid.Count, passes, reshaped);
    }

    /// <summary>
    /// The last stage, for what the Laplacian cannot do: the corner nodes of the cubes that are still bad are tried in a few
    /// directions (the axes, towards the average of their neighbours, along the surface normal) and a few step lengths, and the
    /// best step that keeps every cube around valid and lowers the cost of the neighbourhood is taken. No node goes farther
    /// than tolerance x its local edge length from where it was when this stage began. It is a plain greedy search, run for
    /// at most `sweeps` rounds.
    /// </summary>
    private int Reshape(CubeQuality quality, double tolerance, int sweeps)
    {
        var origin = new Dictionary<int, Vec3>();
        var radius = new Dictionary<int, double>();
        var moved = new HashSet<int>();
        for (int sweep = 0; sweep < sweeps; sweep++)
        {
            var candidates = _owners.Where(o => o.Value.All(x => Hex20Reference.IsCorner(x.Slot)) && o.Value.Any(x => quality.IsBad(x.Hex))).Select(o => o.Key).OrderBy(id => id).ToList();
            bool improved = false;
            foreach (int id in candidates)
            {
                var node = _nodes[id];
                if (!origin.ContainsKey(id))
                {
                    origin[id] = node.Position;
                    var neighbours = CornerNeighbours(id, surfaceOnly: false);
                    radius[id] = tolerance * (neighbours.Count > 0 ? neighbours.Average(n => (_nodes[n].Position - node.Position).Length) : 0);
                }
                if (radius[id] <= 1e-12) continue;
                if (TryReshape(quality, id, origin[id], radius[id])) { moved.Add(id); improved = true; }
            }
            if (!improved) break;
        }
        return moved.Count;
    }

    private bool TryReshape(CubeQuality quality, int nodeId, Vec3 origin, double radius)
    {
        var start = _nodes[nodeId].Position;
        var snapshot = new Dictionary<int, Vec3>();
        foreach (var (hexId, _) in _owners[nodeId])
            foreach (int id in _hexes[hexId].NodeIds) snapshot[id] = _nodes[id].Position;
        double costBefore = quality.Cost(nodeId), worstBefore = quality.Worst(nodeId);
        var neighbours = CornerNeighbours(nodeId, surfaceOnly: false);
        var directions = new List<Vec3> { new(1, 0, 0), new(-1, 0, 0), new(0, 1, 0), new(0, -1, 0), new(0, 0, 1), new(0, 0, -1) };
        if (neighbours.Count > 0)
        {
            var toAverage = neighbours.Aggregate(Vec3.Zero, (a, n) => a + _nodes[n].Position) * (1.0 / neighbours.Count) - start;
            if (toAverage.Length > 1e-12) directions.Add(toAverage * (1 / toAverage.Length));
        }
        var normal = SurfaceNormal(nodeId);
        if (normal is not null) { directions.Add(normal.Value); directions.Add(normal.Value * -1); }

        Vec3? best = null;
        double bestScore = double.MaxValue;
        foreach (var direction in directions)
            foreach (double fraction in new[] { 0.5, 0.25, 0.1 })
            {
                var target = start + direction * (radius * fraction);
                if ((target - origin).Length > radius * (1 + 1e-9)) continue;
                DragNode(nodeId, target);
                quality.Changed(nodeId);
                bool valid = quality.ValidAround(nodeId);
                double score = valid ? quality.Cost(nodeId) : double.PositiveInfinity;
                // a folded cube around: the step counts when the worst cube gets better (then the score is the worst's negative)
                if (!valid && worstBefore <= 1e-9 && quality.Worst(nodeId) > worstBefore + 1e-12) score = 1e30 - quality.Worst(nodeId);
                bool better = valid ? score < costBefore * (1 - 1e-6) : score < 1e30 + 1;
                if (better && score < bestScore) (best, bestScore) = (target, score);
                foreach (var (id, p) in snapshot) _nodes[id].Position = p;
                quality.Changed(nodeId);
            }
        if (best is null) return false;
        DragNode(nodeId, best.Value);
        quality.Changed(nodeId);
        return true;
    }

    // A cube is "good enough" when its smallest Jacobian determinant is at least this fraction of its largest (1 is a
    // parallelepiped). A step that leaves every cube around the node good enough is always fine, so the smoothing does not
    // stall on a mesh that is already fine.
    private const double GoodEnough = 0.5;

    // moves the corner by `step` (its edge midpoints by half). Taken when the cubes around it stay valid and either all are
    // good enough or the cost of the neighbourhood (the sum of 1 / quality over its cubes) does not grow; a step that only
    // makes a folded cube better is taken too when untangling. Halved up to four times, and dropped if it still is not
    // accepted. (A rule on the single worst cube deadlocks when many things are bent at once: each fix makes some other
    // cube a little worse until its own turn. The sum lets that trade happen but heavily punishes a cube that heads for
    // degeneracy, which is what a step at a curved boundary does.)
    private bool TryMoveKeepingValid(CubeQuality quality, int nodeId, Vec3 step, bool untangling = false)
    {
        var start = _nodes[nodeId].Position;
        var snapshot = new Dictionary<int, Vec3>();
        foreach (var (hexId, _) in _owners[nodeId])
            foreach (int id in _hexes[hexId].NodeIds) snapshot[id] = _nodes[id].Position;
        double before = quality.Cost(nodeId);
        double worstBefore = quality.Worst(nodeId);
        for (int attempt = 0; attempt < 5; attempt++, step *= 0.5)
        {
            DragNode(nodeId, start + step);
            quality.Changed(nodeId);
            if (Accepts(quality, nodeId, before, worstBefore, untangling)) return true;
            foreach (var (id, p) in snapshot) _nodes[id].Position = p;
            quality.Changed(nodeId);
        }
        return false;
    }

    // moves one edge midpoint by `pull`, accepted by the same rule
    private bool TryMoveMidpoint(CubeQuality quality, int nodeId, Vec3 pull, bool untangling)
    {
        var start = _nodes[nodeId].Position;
        double before = quality.Cost(nodeId);
        double worstBefore = quality.Worst(nodeId);
        for (int attempt = 0; attempt < 5; attempt++, pull *= 0.5)
        {
            _nodes[nodeId].Position = start + pull;
            quality.Changed(nodeId);
            if (Accepts(quality, nodeId, before, worstBefore, untangling)) return true;
        }
        _nodes[nodeId].Position = start;
        quality.Changed(nodeId);
        return false;
    }

    private static bool Accepts(CubeQuality quality, int nodeId, double costBefore, double worstBefore, bool untangling)
    {
        if (quality.ValidAround(nodeId))
            return quality.Worst(nodeId) >= GoodEnough || quality.Cost(nodeId) <= costBefore * (1 + 1e-9);
        // still folded around the node: only a step that makes the worst cube better counts, and only when untangling
        return untangling && worstBefore <= 1e-9 && quality.Worst(nodeId) > worstBefore + 1e-12;
    }

    /// <summary>
    /// The quality of the cubes around a node, kept between steps: a cube's smallest and largest Jacobian determinant is
    /// worked out once and only again when one of its nodes has moved.
    /// </summary>
    private sealed class CubeQuality(HexMesh mesh)
    {
        private readonly Dictionary<int, (double Min, double Max)> _range = new();

        private (double Min, double Max) Range(int hexId)
        {
            if (!_range.TryGetValue(hexId, out var range))
            {
                range = Hex20Geometry.DeterminantRange(mesh._hexes[hexId].Positions());
                _range[hexId] = range;
            }
            return range;
        }

        public void Changed(int nodeId)
        {
            foreach (var (hexId, _) in mesh._owners[nodeId]) _range.Remove(hexId);
        }

        // a folded cube: not above 1e-9; otherwise smallest / largest determinant, 1 for the most regular cube
        private double Of(int hexId)
        {
            var (min, max) = Range(hexId);
            return min <= 1e-9 ? min : min / max;
        }

        public bool Valid(int hexId) => Range(hexId).Min > 1e-9;

        // below GoodEnough (or folded)
        public bool IsBad(int hexId) => Of(hexId) < GoodEnough;

        public double Worst(int nodeId) => mesh._owners[nodeId].Min(o => Of(o.Hex));

        // the sum of 1 / quality over the cubes around the node (infinite while one is folded)
        public double Cost(int nodeId) => mesh._owners[nodeId].Sum(o => Of(o.Hex) <= 1e-9 ? double.PositiveInfinity : 1 / Of(o.Hex));

        public bool ValidAround(int nodeId) => mesh._owners[nodeId].All(o => Valid(o.Hex));
    }

    // The midpoint nodes that may be straightened with the corner nodes of their edge: those of edges inside the body, and
    // those of any edge of a cube in `folded` (its surface edges too: it cannot be unfolded otherwise)
    private List<(int Id, int A, int B)> EdgeMidpoints(HashSet<int> folded)
    {
        var edges = new Dictionary<int, (int Id, int A, int B)>();
        var onSurface = new HashSet<int>();
        foreach (var hex in _hexes.Values)
            for (int k = 0; k < Hex20Reference.EdgeCorners.Length; k++)
            {
                var (a, b) = Hex20Reference.EdgeCorners[k];
                int mid = hex.NodeIds[8 + k];
                edges[mid] = (mid, hex.NodeIds[a], hex.NodeIds[b]);
                if (EdgeOnSurface(hex.Id, a, b)) onSurface.Add(mid);
            }
        var freed = folded.SelectMany(hexId => Enumerable.Range(8, 12).Select(slot => _hexes[hexId].NodeIds[slot])).ToHashSet();
        return edges.Values.Where(m => !onSurface.Contains(m.Id) || freed.Contains(m.Id)).OrderBy(m => m.Id).ToList();
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
