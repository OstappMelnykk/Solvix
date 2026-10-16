namespace Solvix.Mesh;

/// <summary>
/// The editing session over one mesh: every command either applies fully and
/// becomes one undo step, or fails and leaves the mesh untouched. Undo/redo
/// are snapshot (memento) based, so any future command gets history for free.
/// </summary>
public sealed class HexMeshEditor
{
    private const int MaxHistory = 200;

    private readonly List<HexMeshState> _undo = new();
    private readonly List<HexMeshState> _redo = new();

    public HexMeshEditor() : this(new HexMesh()) { }

    public HexMeshEditor(HexMesh mesh) => Mesh = mesh;

    public HexMesh Mesh { get; private set; }

    /// <summary>Bumped on every successful change, undo and redo; lets clients spot stale state.</summary>
    public int Version { get; private set; }

    public bool CanUndo => _undo.Count > 0;
    public bool CanRedo => _redo.Count > 0;

    /// <param name="shape">A designed cube to start from; the plain unit cube when null.</param>
    /// <param name="cell">The lattice cell to put it in; (0, 0, 0) when null.</param>
    public EditResult AddFirstHex(HexShape? shape = null, (int I, int J, int K)? cell = null) => Apply(() =>
        Mesh.Hexes.Count > 0 ? EditResult.Fail("The mesh already has hexes.") : Run(() => Mesh.AddFirst(shape, cell)));

    /// <param name="shape">A designed cube to attach (fitted onto the face); a plain extrusion of the face when null.</param>
    public EditResult AddHexOnFace(int hexId, HexFace face, HexShape? shape = null) => Apply(() =>
    {
        if (!Mesh.HasHex(hexId)) return EditResult.Fail($"Unknown hex {hexId}.");
        return Run(() => Mesh.AddOnFace(hexId, face, shape));
    });

    /// <summary>Adds a ready-made body (see <see cref="HexMesh.AddBody"/>) as one undo step.</summary>
    public EditResult AddBody(BodyPlan plan) => Apply(() => Run(() => Mesh.AddBody(plan)));

    /// <summary>
    /// Adds a template body as one undo step: the mesh keeps only one template body, so the one that was added
    /// before is removed, and the new one is put with its centre at the origin.
    /// </summary>
    public EditResult AddTemplateBody(BodyPlan plan) => Apply(() => Run(() =>
    {
        foreach (int id in Mesh.Hexes.Where(h => h.IsTemplate).Select(h => h.Id).ToList()) Mesh.RemoveHex(id);
        Mesh.AddBody(plan, centred: true, template: true);
    }));

    public EditResult LinkFaces(FaceRef first, FaceRef second, LinkFit fit) => Apply(() =>
        Mesh.TryLinkFaces(first, second, fit, out var error) ? EditResult.Success : EditResult.Fail(error ?? "Link refused."));

    /// <summary>
    /// Makes two hexes neighbours without naming faces: when their ideal cells
    /// touch, the shared face is the one between them. This is how the user
    /// links cubes whose common face cannot be clicked from outside.
    /// </summary>
    public EditResult LinkHexes(int hexA, int hexB, LinkFit fit) => Apply(() =>
    {
        if (!Mesh.HasHex(hexA)) return EditResult.Fail($"Unknown hex {hexA}.");
        if (!Mesh.HasHex(hexB)) return EditResult.Fail($"Unknown hex {hexB}.");
        if (hexA == hexB) return EditResult.Fail("A hex cannot be linked to itself.");
        var a = Mesh.Hex(hexA).Cell;
        var b = Mesh.Hex(hexB).Cell;
        var delta = (b.I - a.I, b.J - a.J, b.K - a.K);
        HexFace? shared = null;
        foreach (var f in HexFaces.All)
            if (f.Offset() == delta) shared = f;
        if (shared is not HexFace face)
        {
            int apart = new[] { delta.Item1, delta.Item2, delta.Item3 }.Count(d => d != 0);
            bool touching = Math.Abs(delta.Item1) <= 1 && Math.Abs(delta.Item2) <= 1 && Math.Abs(delta.Item3) <= 1;
            if (touching)
                return EditResult.Fail(
                    $"These hexes touch only {(apart == 2 ? "along an edge" : "at a corner")}, not across a face, so they cannot be neighbours. " +
                    "To connect them, add a hex that touches both (nodes along the shared edge are already shared through their common neighbours).");
            return EditResult.Fail("These hexes are not adjacent in the ideal lattice.");
        }
        return Mesh.TryLinkFaces(new FaceRef(hexA, face), new FaceRef(hexB, face.Opposite()), fit, out var error)
            ? EditResult.Success
            : EditResult.Fail(error ?? "Link refused.");
    });

    /// <summary>
    /// Deletes a hex. Refused when that would split the body into separate
    /// parts (docs/GEOMETRY_RULES.md, R2); deleting the last hex is allowed.
    /// </summary>
    public EditResult RemoveHex(int hexId) => Apply(() =>
    {
        if (!Mesh.HasHex(hexId)) return EditResult.Fail($"Unknown hex {hexId}.");
        var parts = Mesh.ComponentSizesWithout(hexId);
        if (parts.Count > 1)
            return EditResult.Fail($"Removing hex {hexId} would split the body into {parts.Count} parts ({string.Join(" + ", parts)} cubes).");
        Mesh.RemoveHex(hexId);
        return EditResult.Success;
    });

    public EditResult UnlinkFace(int hexId, HexFace face) => Apply(() =>
    {
        if (!Mesh.HasHex(hexId)) return EditResult.Fail($"Unknown hex {hexId}.");
        if (Mesh.Neighbor(hexId, face) is null) return EditResult.Fail("That face is not linked.");
        Mesh.Unlink(hexId, face);
        return EditResult.Success;
    });

    /// <param name="carryEdgeMidpoints">When true, dragging a corner also moves its edges' midpoints by half.</param>
    public EditResult MoveNode(int nodeId, Vec3 position, bool carryEdgeMidpoints) => Apply(() =>
    {
        if (!Mesh.HasNode(nodeId)) return EditResult.Fail($"Unknown node {nodeId}.");
        if (!IsFinite(position)) return EditResult.Fail("The position must be a finite number.");
        if (carryEdgeMidpoints) Mesh.DragNode(nodeId, position);
        else Mesh.SetNodePosition(nodeId, position);
        return EditResult.Success;
    });

    /// <summary>
    /// Moves a whole face by one displacement, as a single undoable step. The 8
    /// face nodes move by the full delta; the midpoints of the edges joining the
    /// face to the opposite one move by half, keeping those edges straight.
    /// </summary>
    public EditResult MoveFace(FaceRef face, Vec3 delta) => Apply(() =>
    {
        if (!Mesh.HasHex(face.Hex)) return EditResult.Fail($"Unknown hex {face.Hex}.");
        if (!IsFinite(delta)) return EditResult.Fail("The displacement must be a finite number.");
        Mesh.MoveFace(face, delta);
        return EditResult.Success;
    });

    public EditResult Reset() => Apply(() =>
    {
        Mesh = new HexMesh();
        return EditResult.Success;
    });

    public bool Undo()
    {
        if (_undo.Count == 0) return false;
        _redo.Add(Mesh.ToState());
        Mesh = HexMesh.FromState(Pop(_undo));
        Version++;
        return true;
    }

    public bool Redo()
    {
        if (_redo.Count == 0) return false;
        _undo.Add(Mesh.ToState());
        Mesh = HexMesh.FromState(Pop(_redo));
        Version++;
        return true;
    }

    // Runs a command against the live mesh; if it fails (or throws) the mesh is
    // restored from the snapshot taken first, so a refused command never leaves
    // half a change behind.
    private EditResult Apply(Func<EditResult> command)
    {
        var before = Mesh.ToState();
        EditResult result;
        try
        {
            result = command();
        }
        catch (InvalidOperationException error)
        {
            result = EditResult.Fail(error.Message);
        }
        if (!result.Ok)
        {
            Mesh = HexMesh.FromState(before);
            return result;
        }
        _undo.Add(before);
        if (_undo.Count > MaxHistory) _undo.RemoveAt(0);
        _redo.Clear();
        Version++;
        return result;
    }

    private static EditResult Run(Action action)
    {
        action();
        return EditResult.Success;
    }

    private static HexMeshState Pop(List<HexMeshState> stack)
    {
        var last = stack[^1];
        stack.RemoveAt(stack.Count - 1);
        return last;
    }

    private static bool IsFinite(Vec3 v) => double.IsFinite(v.X) && double.IsFinite(v.Y) && double.IsFinite(v.Z);
}
