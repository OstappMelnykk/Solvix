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

    public EditResult AddFirstHex() => Apply(() =>
        Mesh.Hexes.Count > 0 ? EditResult.Fail("The mesh already has hexes.") : Run(() => Mesh.AddFirst()));

    public EditResult AddHexOnFace(int hexId, HexFace face) => Apply(() =>
    {
        if (!Mesh.HasHex(hexId)) return EditResult.Fail($"Unknown hex {hexId}.");
        return Run(() => Mesh.AddOnFace(hexId, face));
    });

    public EditResult LinkFaces(FaceRef first, FaceRef second, LinkFit fit) => Apply(() =>
        Mesh.TryLinkFaces(first, second, fit, out var error) ? EditResult.Success : EditResult.Fail(error ?? "Link refused."));

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
