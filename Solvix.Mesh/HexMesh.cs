namespace Solvix.Mesh;

/// <summary>
/// A body assembled from curvilinear 20-node hexes, built Minecraft-style by
/// attaching cubes to faces.
///
/// Two worlds share one topology:
///  - real world: node positions, freely deformable (isoparametric map of the
///    hex's 20 nodes);
///  - ideal world: every hex is a unit cell of an integer lattice.
///
/// Adjacency is explicit. Two hexes are neighbours only if linked through a
/// face; cells that merely sit side by side stay independent (their nodes are
/// separate even when coincident) until the user links them. Linked hexes
/// share the 8 nodes of the common face, so dragging a shared node deforms
/// every hex that owns it.
/// </summary>
public sealed class HexMesh
{
    private readonly Dictionary<int, MeshNode> _nodes = new();
    private readonly Dictionary<int, Hex20> _hexes = new();
    private readonly Dictionary<(int, int, int), int> _cells = new();
    private readonly Dictionary<(int Hex, HexFace Face), int> _links = new();
    private readonly Dictionary<int, List<(int Hex, int Slot)>> _owners = new();
    private int _nextNodeId;
    private int _nextHexId;

    public IReadOnlyCollection<Hex20> Hexes => _hexes.Values;
    public IReadOnlyCollection<MeshNode> Nodes => _nodes.Values;

    public Hex20 Hex(int id) => _hexes[id];
    public MeshNode Node(int id) => _nodes[id];

    public bool HasHex(int id) => _hexes.ContainsKey(id);
    public bool HasNode(int id) => _nodes.ContainsKey(id);

    public Hex20? HexAtCell((int I, int J, int K) cell) => _cells.TryGetValue(cell, out var id) ? _hexes[id] : null;

    /// <summary>The hexes (with the slot each uses) that own a node.</summary>
    public IReadOnlyList<(int Hex, int Slot)> OwnersOf(int nodeId) => _owners[nodeId];

    /// <summary>Linked neighbour across a face, or null.</summary>
    public int? Neighbor(int hexId, HexFace face) => _links.TryGetValue((hexId, face), out var n) ? n : null;

    /// <summary>Creates the first unit cube: real coordinates equal ideal ones.</summary>
    public Hex20 AddFirst()
    {
        if (_hexes.Count > 0) throw new InvalidOperationException("The mesh already has hexes; use AddOnFace.");
        var hex = NewHex((0, 0, 0));
        for (int s = 0; s < Hex20Reference.NodeCount; s++)
        {
            var ideal = IdealOf(hex.Cell, s);
            hex.NodeIds[s] = NewNode(new Vec3(ideal.X / 2.0, ideal.Y / 2.0, ideal.Z / 2.0), ideal).Id;
            Own(hex.NodeIds[s], hex.Id, s);
        }
        return hex;
    }

    /// <summary>
    /// Attaches a new cube to a face of <paramref name="hostId"/> and links
    /// them. New nodes are placed by continuing the host's isoparametric map
    /// past the shared face, so a deformed host yields a smoothly continued cube.
    /// </summary>
    public Hex20 AddOnFace(int hostId, HexFace face)
    {
        var host = _hexes[hostId];
        if (_links.ContainsKey((hostId, face))) throw new InvalidOperationException("That face is already linked.");
        var (di, dj, dk) = face.Offset();
        var cell = (host.Cell.I + di, host.Cell.J + dj, host.Cell.K + dk);
        if (_cells.ContainsKey(cell)) throw new InvalidOperationException($"Cell {cell} is already occupied.");

        var hex = NewHex(cell);
        int axis = face.Axis(), sign = face.Sign();
        var shared = face.Opposite();
        for (int s = 0; s < Hex20Reference.NodeCount; s++)
        {
            int hostSlot = shared.PartnerSlot(s);
            if (hostSlot >= 0)
            {
                hex.NodeIds[s] = host.NodeIds[hostSlot];
            }
            else
            {
                var xi = new Vec3(Hex20Reference.LocalCoords[s, 0], Hex20Reference.LocalCoords[s, 1], Hex20Reference.LocalCoords[s, 2]);
                xi = xi.With(axis, xi[axis] + 2 * sign);
                hex.NodeIds[s] = NewNode(host.Map(xi), IdealOf(cell, s)).Id;
            }
            Own(hex.NodeIds[s], hex.Id, s);
        }
        _links[(hostId, face)] = hex.Id;
        _links[(hex.Id, shared)] = hostId;
        return hex;
    }

    /// <summary>
    /// Makes the hex across <paramref name="face"/> (by lattice cell) a
    /// neighbour and merges the 8 shared nodes. Refused unless the two faces
    /// currently coincide in real space.
    /// </summary>
    public bool TryLink(int hexId, HexFace face, out string? error, double tolerance = 1e-6)
    {
        error = null;
        var a = _hexes[hexId];
        var (di, dj, dk) = face.Offset();
        var b = HexAtCell((a.Cell.I + di, a.Cell.J + dj, a.Cell.K + dk));
        if (b is null) { error = "There is no hex across that face."; return false; }
        if (_links.ContainsKey((a.Id, face)) || _links.ContainsKey((b.Id, face.Opposite())))
        {
            error = "One of the two faces is already linked.";
            return false;
        }

        var pairs = face.Slots().Select(s => (A: a.NodeIds[s], B: b.NodeIds[face.PartnerSlot(s)])).ToList();
        foreach (var (na, nb) in pairs)
        {
            if (na != nb && (Node(na).Position - Node(nb).Position).Length > tolerance)
            {
                error = "The faces do not coincide in real space; move the nodes together first.";
                return false;
            }
        }
        foreach (var (na, nb) in pairs)
        {
            if (na != nb) Merge(na, nb);
        }
        _links[(a.Id, face)] = b.Id;
        _links[(b.Id, face.Opposite())] = a.Id;
        return true;
    }

    /// <summary>
    /// Removes a hex together with its links and any node nobody else owns. Nodes
    /// that other hexes shared only through this one are split again, so the
    /// remaining hexes keep exactly the nodes their links justify.
    /// </summary>
    public void RemoveHex(int hexId)
    {
        var hex = _hexes[hexId];
        foreach (var face in HexFaces.All)
        {
            if (!_links.TryGetValue((hexId, face), out int other)) continue;
            _links.Remove((hexId, face));
            _links.Remove((other, face.Opposite()));
        }
        var nodeIds = hex.NodeIds.Distinct().ToList();
        foreach (int id in nodeIds)
        {
            _owners[id].RemoveAll(o => o.Hex == hexId);
            if (_owners[id].Count == 0)
            {
                _owners.Remove(id);
                _nodes.Remove(id);
            }
        }
        _cells.Remove(hex.Cell);
        _hexes.Remove(hexId);
        foreach (int id in nodeIds)
        {
            if (_nodes.ContainsKey(id)) Rebuild(id);
        }
    }

    /// <summary>
    /// Sizes of the connected groups (through neighbour links) the body would
    /// fall into if <paramref name="hexId"/> were removed; one entry means it
    /// stays whole, none means it was the last hex.
    /// </summary>
    public IReadOnlyList<int> ComponentSizesWithout(int hexId)
    {
        var seen = new HashSet<int> { hexId };
        var sizes = new List<int>();
        foreach (var start in _hexes.Keys.OrderBy(i => i))
        {
            if (seen.Contains(start)) continue;
            int size = 0;
            var stack = new Stack<int>();
            stack.Push(start);
            seen.Add(start);
            while (stack.Count > 0)
            {
                int current = stack.Pop();
                size++;
                foreach (var face in HexFaces.All)
                {
                    if (_links.TryGetValue((current, face), out int next) && seen.Add(next)) stack.Push(next);
                }
            }
            sizes.Add(size);
        }
        return sizes;
    }

    /// <summary>Removes the neighbour relation; nodes no longer connected through any link are split.</summary>
    public void Unlink(int hexId, HexFace face)
    {
        if (!_links.TryGetValue((hexId, face), out var otherId)) return;
        _links.Remove((hexId, face));
        _links.Remove((otherId, face.Opposite()));
        foreach (int s in face.Slots()) Rebuild(_hexes[hexId].NodeIds[s]);
    }

    /// <summary>The 8 node ids lying on a face (4 corners then 4 midpoints, in slot order).</summary>
    public IReadOnlyList<int> FaceNodeIds(FaceRef face) => face.Face.Slots().Select(s => _hexes[face.Hex].NodeIds[s]).ToList();

    /// <summary>What a face currently is: open, linked, or sitting against an unlinked hex (and how far apart the two faces are).</summary>
    public FaceState GetFaceState(FaceRef face, double tolerance = 1e-6)
    {
        var hex = _hexes[face.Hex];
        if (_links.TryGetValue((face.Hex, face.Face), out int linked))
            return new FaceState(face, FaceStatus.Linked, new FaceRef(linked, face.Face.Opposite()), true, 0);
        var (di, dj, dk) = face.Face.Offset();
        var other = HexAtCell((hex.Cell.I + di, hex.Cell.J + dj, hex.Cell.K + dk));
        if (other is null) return new FaceState(face, FaceStatus.Free, null, null, null);
        double gap = FaceGap(face, new FaceRef(other.Id, face.Face.Opposite()));
        return new FaceState(face, FaceStatus.Candidate, new FaceRef(other.Id, face.Face.Opposite()), gap <= tolerance, gap);
    }

    public IReadOnlyList<FaceState> AllFaceStates(double tolerance = 1e-6) =>
        _hexes.Values.OrderBy(h => h.Id).SelectMany(h => HexFaces.All.Select(f => GetFaceState(new FaceRef(h.Id, f), tolerance))).ToList();

    /// <summary>Largest real-space distance between corresponding nodes of two opposite faces.</summary>
    public double FaceGap(FaceRef a, FaceRef b)
    {
        var ha = _hexes[a.Hex];
        var hb = _hexes[b.Hex];
        return a.Face.Slots().Max(s => (Node(ha.NodeIds[s]).Position - Node(hb.NodeIds[a.Face.PartnerSlot(s)]).Position).Length);
    }

    /// <summary>
    /// Links two clicked faces. They must be opposite faces of lattice-adjacent
    /// hexes (the ideal world is a lattice, so only those can be neighbours).
    /// <see cref="LinkFit.Strict"/> needs the faces to coincide already;
    /// <see cref="LinkFit.AdaptSecond"/> first fits the second hex's face onto
    /// the first one, leaving sizes of both hexes' far faces alone.
    /// </summary>
    public bool TryLinkFaces(FaceRef first, FaceRef second, LinkFit fit, out string? error, double tolerance = 1e-6)
    {
        error = null;
        if (!_hexes.ContainsKey(first.Hex) || !_hexes.ContainsKey(second.Hex)) { error = "Unknown hex."; return false; }
        if (first.Hex == second.Hex) { error = "A hex cannot be linked to itself."; return false; }
        if (second.Face != first.Face.Opposite()) { error = "The two faces must face each other."; return false; }
        var a = _hexes[first.Hex];
        var (di, dj, dk) = first.Face.Offset();
        if (second.Hex != HexAtCell((a.Cell.I + di, a.Cell.J + dj, a.Cell.K + dk))?.Id)
        {
            error = "These hexes are not adjacent in the ideal lattice.";
            return false;
        }
        if (_links.ContainsKey((first.Hex, first.Face)) || _links.ContainsKey((second.Hex, second.Face)))
        {
            error = "One of the two faces is already linked.";
            return false;
        }
        if (fit == LinkFit.AdaptSecond && FaceGap(first, second) > tolerance) FitFace(second, first);
        return TryLink(first.Hex, first.Face, out error, tolerance);
    }

    // Moves `moving`'s face onto `target`'s and carries the rest of that hex
    // along: a node's displacement is the displacement of its counterpart on the
    // face, weighted 1 on the face, 1/2 mid-way, 0 on the far side - so the far
    // face (and the hex's overall size) is left alone.
    private void FitFace(FaceRef moving, FaceRef target)
    {
        var hm = _hexes[moving.Hex];
        var ht = _hexes[target.Hex];
        int axis = moving.Face.Axis(), sign = moving.Face.Sign();
        var correction = new Dictionary<int, Vec3>();
        foreach (int s in moving.Face.Slots())
            correction[s] = Node(ht.NodeIds[moving.Face.PartnerSlot(s)]).Position - Node(hm.NodeIds[s]).Position;

        var moves = new Dictionary<int, Vec3>();
        for (int s = 0; s < Hex20Reference.NodeCount; s++)
        {
            int onFace = moving.Face.Slots().First(f => Enumerable.Range(0, 3).All(d => d == axis || Hex20Reference.LocalCoords[f, d] == Hex20Reference.LocalCoords[s, d]));
            double w = (1 + Hex20Reference.LocalCoords[s, axis] * sign) / 2.0;
            moves[hm.NodeIds[s]] = Node(hm.NodeIds[s]).Position + correction[onFace] * w;
        }
        foreach (var (id, pos) in moves) _nodes[id].Position = pos;
    }

    /// <summary>Cells that sit face to face but are not linked: candidates for the linking tool.</summary>
    public IReadOnlyList<(int HexA, HexFace Face, int HexB)> LinkCandidates()
    {
        var result = new List<(int, HexFace, int)>();
        foreach (var hex in _hexes.Values)
        {
            foreach (var face in HexFaces.All)
            {
                if (face.Sign() < 0 || _links.ContainsKey((hex.Id, face))) continue;
                var (di, dj, dk) = face.Offset();
                var other = HexAtCell((hex.Cell.I + di, hex.Cell.J + dj, hex.Cell.K + dk));
                if (other is not null && !_links.ContainsKey((other.Id, face.Opposite())))
                    result.Add((hex.Id, face, other.Id));
            }
        }
        return result;
    }

    /// <summary>
    /// Drags a node. A corner carries the midpoints of its edges by half the
    /// displacement (edges keep their curvature); a midpoint bends only its edge.
    /// Every hex sharing the node follows because the node is shared.
    /// </summary>
    public void DragNode(int nodeId, Vec3 newPosition)
    {
        var node = _nodes[nodeId];
        var delta = newPosition - node.Position;
        var moved = new HashSet<int>();
        if (_owners[nodeId].Any(o => Hex20Reference.IsCorner(o.Slot)))
        {
            foreach (var (hexId, slot) in _owners[nodeId])
            {
                for (int k = 0; k < Hex20Reference.EdgeCorners.Length; k++)
                {
                    var (ca, cb) = Hex20Reference.EdgeCorners[k];
                    if (ca == slot || cb == slot) moved.Add(_hexes[hexId].NodeIds[8 + k]);
                }
            }
        }
        node.Position = newPosition;
        foreach (int mid in moved) _nodes[mid].Position += delta * 0.5;
    }

    /// <summary>Moves a single node without touching any other.</summary>
    public void SetNodePosition(int nodeId, Vec3 position) => _nodes[nodeId].Position = position;

    /// <summary>Hexes whose map is folded or degenerate. Never blocks editing; the solver checks it before solving.</summary>
    public IReadOnlyList<int> InvalidHexes() => _hexes.Values.Where(h => !h.IsValid()).Select(h => h.Id).OrderBy(i => i).ToList();

    /// <summary>
    /// Ideal point (lattice units) to real space. A point on a cell boundary
    /// belongs to the cell on its positive side; if that cell is empty the
    /// negative side is used, so the outer boundary of the body maps too. Across
    /// linked hexes the two sides agree (they share the face nodes).
    /// </summary>
    public bool TryMapIdealToReal(Vec3 ideal, out Vec3 real)
    {
        real = Vec3.Zero;
        var hex = CellFor(ideal);
        if (hex is null) return false;
        real = hex.Map(LocalOf(hex, ideal));
        return true;
    }

    private Hex20? CellFor(Vec3 ideal)
    {
        int[] lo = { (int)Math.Floor(ideal.X), (int)Math.Floor(ideal.Y), (int)Math.Floor(ideal.Z) };
        bool[] onBoundary = { ideal.X == lo[0], ideal.Y == lo[1], ideal.Z == lo[2] };
        for (int mask = 0; mask < 8; mask++)
        {
            var c = new int[3];
            bool ok = true;
            for (int d = 0; d < 3; d++)
            {
                bool minus = (mask >> d & 1) == 1;
                if (minus && !onBoundary[d]) { ok = false; break; }
                c[d] = lo[d] - (minus ? 1 : 0);
            }
            if (!ok) continue;
            var hex = HexAtCell((c[0], c[1], c[2]));
            if (hex is not null) return hex;
        }
        return null;
    }

    private static Vec3 LocalOf(Hex20 hex, Vec3 ideal) =>
        new((ideal.X - hex.Cell.I) * 2 - 1, (ideal.Y - hex.Cell.J) * 2 - 1, (ideal.Z - hex.Cell.K) * 2 - 1);

    /// <summary>
    /// Finds the hex containing a real point and its local coordinates. When
    /// several hexes contain it (a shared face, or overlapping unlinked hexes)
    /// the one where the point is deepest inside wins, ties going to the lower id.
    /// </summary>
    public bool TryLocate(Vec3 real, out int hexId, out Vec3 xi, double slack = 1e-9)
    {
        hexId = -1;
        xi = Vec3.Zero;
        double bestDepth = double.MaxValue;
        foreach (var hex in _hexes.Values.OrderBy(h => h.Id))
        {
            var (min, max) = hex.Bounds();
            if (real.X < min.X || real.Y < min.Y || real.Z < min.Z || real.X > max.X || real.Y > max.Y || real.Z > max.Z) continue;
            if (!TryInvertFromSeveralStarts(hex, real, out var local)) continue;
            double depth = Math.Max(Math.Abs(local.X), Math.Max(Math.Abs(local.Y), Math.Abs(local.Z)));
            if (depth > 1 + slack || depth >= bestDepth - 1e-12) continue;
            bestDepth = depth;
            hexId = hex.Id;
            xi = local;
        }
        return hexId >= 0;
    }

    // Newton from the centre first, then from the 8 octant centres: a strongly
    // curved hex can send a single start to a root outside the cube.
    private static bool TryInvertFromSeveralStarts(Hex20 hex, Vec3 real, out Vec3 xi)
    {
        if (hex.TryInvertMap(real, out xi)) return true;
        for (int mask = 0; mask < 8; mask++)
        {
            var start = new Vec3((mask & 1) == 0 ? -0.5 : 0.5, (mask & 2) == 0 ? -0.5 : 0.5, (mask & 4) == 0 ? -0.5 : 0.5);
            if (hex.TryInvertMap(real, start, out xi)) return true;
        }
        return false;
    }

    /// <summary>Real point to ideal lattice units.</summary>
    public bool TryMapRealToIdeal(Vec3 real, out Vec3 ideal, double slack = 1e-9)
    {
        ideal = Vec3.Zero;
        if (!TryLocate(real, out int hexId, out var xi, slack)) return false;
        var hex = _hexes[hexId];
        ideal = new Vec3(hex.Cell.I + (xi.X + 1) / 2, hex.Cell.J + (xi.Y + 1) / 2, hex.Cell.K + (xi.Z + 1) / 2);
        return true;
    }

    public HexMeshState ToState() => new(
        _nextNodeId,
        _nextHexId,
        _nodes.Values.OrderBy(n => n.Id).Select(n => new NodeState(n.Id, n.Position, n.Ideal.X, n.Ideal.Y, n.Ideal.Z)).ToList(),
        _hexes.Values.OrderBy(h => h.Id).Select(h => new HexState(h.Id, h.Cell.I, h.Cell.J, h.Cell.K, h.ParentId, h.NodeIds.ToArray())).ToList(),
        _links.OrderBy(kv => kv.Key.Hex).ThenBy(kv => kv.Key.Face).Select(kv => new LinkState(kv.Key.Hex, kv.Key.Face, kv.Value)).ToList());

    public static HexMesh FromState(HexMeshState state)
    {
        var mesh = new HexMesh { _nextNodeId = state.NextNodeId, _nextHexId = state.NextHexId };
        foreach (var n in state.Nodes)
        {
            mesh._nodes[n.Id] = new MeshNode(n.Id, n.Position, (n.IdealX, n.IdealY, n.IdealZ));
            mesh._owners[n.Id] = new List<(int, int)>();
        }
        foreach (var h in state.Hexes)
        {
            var hex = new Hex20(mesh, h.Id, (h.I, h.J, h.K)) { ParentId = h.ParentId };
            for (int s = 0; s < Hex20Reference.NodeCount; s++)
            {
                hex.NodeIds[s] = h.NodeIds[s];
                mesh._owners[h.NodeIds[s]].Add((h.Id, s));
            }
            mesh._hexes[h.Id] = hex;
            mesh._cells[hex.Cell] = hex.Id;
        }
        foreach (var l in state.Links) mesh._links[(l.Hex, l.Face)] = l.Other;
        return mesh;
    }

    /// <summary>Solver-ready snapshot (nodes and elements ordered by id).</summary>
    public FemMeshData ToFemMesh()
    {
        var nodeIds = _nodes.Keys.OrderBy(i => i).ToArray();
        var elementIds = _hexes.Keys.OrderBy(i => i).ToArray();
        var index = new Dictionary<int, int>();
        var positions = new double[nodeIds.Length, 3];
        for (int n = 0; n < nodeIds.Length; n++)
        {
            index[nodeIds[n]] = n;
            var p = _nodes[nodeIds[n]].Position;
            positions[n, 0] = p.X; positions[n, 1] = p.Y; positions[n, 2] = p.Z;
        }
        var connectivity = new int[elementIds.Length, Hex20Reference.NodeCount];
        for (int e = 0; e < elementIds.Length; e++)
            for (int s = 0; s < Hex20Reference.NodeCount; s++)
                connectivity[e, s] = index[_hexes[elementIds[e]].NodeIds[s]];
        return new FemMeshData
        {
            NodeCount = nodeIds.Length,
            ElementCount = elementIds.Length,
            Positions = positions,
            Connectivity = connectivity,
            NodeIds = nodeIds,
            ElementIds = elementIds,
        };
    }

    private static (int X, int Y, int Z) IdealOf((int I, int J, int K) cell, int slot) => (
        2 * cell.I + Hex20Reference.LocalCoords[slot, 0] + 1,
        2 * cell.J + Hex20Reference.LocalCoords[slot, 1] + 1,
        2 * cell.K + Hex20Reference.LocalCoords[slot, 2] + 1);

    private Hex20 NewHex((int I, int J, int K) cell)
    {
        var hex = new Hex20(this, _nextHexId++, cell);
        _hexes[hex.Id] = hex;
        _cells[cell] = hex.Id;
        return hex;
    }

    private MeshNode NewNode(Vec3 position, (int X, int Y, int Z) ideal)
    {
        var node = new MeshNode(_nextNodeId++, position, ideal);
        _nodes[node.Id] = node;
        _owners[node.Id] = new List<(int, int)>();
        return node;
    }

    private void Own(int nodeId, int hexId, int slot) => _owners[nodeId].Add((hexId, slot));

    // Folds node `from` into `into`: every owner of `from` now points at `into`.
    private void Merge(int into, int from)
    {
        foreach (var (hexId, slot) in _owners[from])
        {
            _hexes[hexId].NodeIds[slot] = into;
            _owners[into].Add((hexId, slot));
        }
        _owners.Remove(from);
        _nodes.Remove(from);
    }

    // Re-derives the identity of one node from the links that remain: owners
    // no longer connected through a chain of links get their own copy.
    private void Rebuild(int nodeId)
    {
        var owners = _owners[nodeId].ToList();
        var component = new Dictionary<(int, int), int>();
        var groups = new List<List<(int Hex, int Slot)>>();
        foreach (var start in owners)
        {
            if (component.ContainsKey(start)) continue;
            var group = new List<(int Hex, int Slot)>();
            var stack = new Stack<(int Hex, int Slot)>();
            stack.Push(start);
            component[start] = groups.Count;
            while (stack.Count > 0)
            {
                var cur = stack.Pop();
                group.Add(cur);
                foreach (var face in HexFaces.All)
                {
                    int partner = face.PartnerSlot(cur.Slot);
                    if (partner < 0 || !_links.TryGetValue((cur.Hex, face), out int other)) continue;
                    var next = (other, partner);
                    if (component.ContainsKey(next) || !owners.Contains(next)) continue;
                    component[next] = groups.Count;
                    stack.Push(next);
                }
            }
            groups.Add(group);
        }
        if (groups.Count <= 1) return;

        var original = _nodes[nodeId];
        _owners[nodeId] = groups[0];
        for (int g = 1; g < groups.Count; g++)
        {
            var copy = NewNode(original.Position, original.Ideal);
            foreach (var (hexId, slot) in groups[g])
            {
                _hexes[hexId].NodeIds[slot] = copy.Id;
                _owners[copy.Id].Add((hexId, slot));
            }
        }
    }
}
