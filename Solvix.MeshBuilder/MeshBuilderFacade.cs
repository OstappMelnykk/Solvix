using Solvix.Contracts.Facades;
using Solvix.Mesh;

namespace Solvix.MeshBuilder;

// Facade (GoF): exposes a simplified, stable surface to callers
// (Solvix.Api) - callers depend only on IMeshBuilderFacade (defined in
// Solvix.Contracts), never on this concrete class or on Solvix.Mesh.
// Internal - only AddMeshBuilder() ever names this type.
internal sealed class MeshBuilderFacade(MeshEditorSessions sessions) : IMeshBuilderFacade
{
    public MeshStateDto GetState(int sessionId) => sessions.With(sessionId, MeshStateMapper.ToDto);

    public MeshCommandResultDto AddFirstHex(int sessionId, MeshShapeDto? shape = null, MeshCellDto? cell = null)
    {
        if (!MeshStateMapper.TryShape(shape, out var parsed, out var error)) return Reject(sessionId, error!);
        return Command(sessionId, e => e.AddFirstHex(parsed, cell is null ? null : (cell.I, cell.J, cell.K)));
    }

    public FemMeshDto ExportFemMesh(int sessionId) => sessions.With(sessionId, editor =>
    {
        var fem = editor.Mesh.ToFemMesh();
        var positions = new double[fem.NodeCount * 3];
        for (int n = 0; n < fem.NodeCount; n++)
            for (int c = 0; c < 3; c++) positions[n * 3 + c] = fem.Positions[n, c];
        var connectivity = new int[fem.ElementCount * 20];
        for (int e = 0; e < fem.ElementCount; e++)
            for (int s = 0; s < 20; s++) connectivity[e * 20 + s] = fem.Connectivity[e, s];
        return new FemMeshDto(fem.NodeCount, fem.ElementCount, positions, connectivity, fem.NodeIds, fem.ElementIds, editor.Mesh.InvalidHexes());
    });

    public MeshTemplateLibraryDto TemplateLibrary() => new(
        HexTemplates.Kinds.Select(k => new MeshTemplateKindDto(k.Name, k.Label, k.Group,
            k.Parameters.Select(p => new MeshTemplateParameterDto(p.Key, p.Label, p.Default, p.Min, p.Max, p.Integer)).ToList())).ToList(),
        HexTemplates.Presets.Select(p => new MeshTemplatePresetDto(p.Name, p.Label, p.Kind, p.Values)).ToList());

    public MeshTemplatePreviewDto PreviewTemplate(MeshTemplateRequestDto request)
    {
        if (!TryBuild(request, out var plan, out var error)) return new MeshTemplatePreviewDto(false, error, null, 0);
        var scratch = new HexMeshEditor();
        scratch.AddBody(plan!);
        return new MeshTemplatePreviewDto(true, null, MeshStateMapper.ToDto(scratch), scratch.Mesh.InvalidHexes().Count);
    }

    public MeshCommandResultDto AddTemplate(int sessionId, MeshTemplateRequestDto request)
    {
        if (!TryBuild(request, out var plan, out var error)) return Reject(sessionId, error!);
        return Command(sessionId, e => e.AddBody(plan!));
    }

    // Unknown kinds, out-of-range values and impossible combinations come back as a message, not an exception.
    private static bool TryBuild(MeshTemplateRequestDto? request, out BodyPlan? plan, out string? error)
    {
        plan = null;
        error = null;
        if (request is null || string.IsNullOrWhiteSpace(request.Kind)) { error = "Choose a template."; return false; }
        try
        {
            plan = HexTemplates.Kind(request.Kind).Build(request.Values);
            return true;
        }
        catch (ArgumentException exception)
        {
            error = exception.Message;
            return false;
        }
    }

    public IReadOnlyList<MeshShapePresetDto> ShapePresets() => HexShapes.Presets
        .Select(p => new MeshShapePresetDto(p.Name, p.Label, new MeshShapeParametersDto(p.Length, p.Height, p.Depth, p.Taper, p.ShearX, p.ShearZ)))
        .ToList();

    public MeshShapeDto BuildShape(MeshShapeParametersDto parameters) =>
        MeshStateMapper.ToDto(HexShapes.Parametric(parameters.Length, parameters.Height, parameters.Depth, parameters.Taper, parameters.ShearX, parameters.ShearZ));

    public MeshShapeCheckDto CheckShape(MeshShapeDto shape)
    {
        if (!MeshStateMapper.TryShape(shape, out var parsed, out var error)) return new MeshShapeCheckDto(false, 0, error);
        double min = parsed!.MinDeterminant();
        return new MeshShapeCheckDto(min > 1e-9, min, null);
    }

    public MeshCommandResultDto AddHexOnFace(int sessionId, int hexId, string face, MeshShapeDto? shape = null)
    {
        if (!MeshStateMapper.TryShape(shape, out var parsed, out var error)) return Reject(sessionId, error!);
        return WithFace(sessionId, face, f => e => e.AddHexOnFace(hexId, f, parsed));
    }

    public MeshCommandResultDto LinkFaces(int sessionId, int hexA, string faceA, int hexB, string faceB, bool adaptSecond)
    {
        if (!MeshStateMapper.TryParseFace(faceA, out var first)) return Reject(sessionId, $"Unknown face \"{faceA}\".");
        if (!MeshStateMapper.TryParseFace(faceB, out var second)) return Reject(sessionId, $"Unknown face \"{faceB}\".");
        return Command(sessionId, e =>
            e.LinkFaces(new FaceRef(hexA, first), new FaceRef(hexB, second), adaptSecond ? LinkFit.AdaptSecond : LinkFit.Strict));
    }

    public MeshCommandResultDto RemoveHex(int sessionId, int hexId) => Command(sessionId, e => e.RemoveHex(hexId));

    public MeshCommandResultDto LinkHexes(int sessionId, int hexA, int hexB, bool adaptSecond) =>
        Command(sessionId, e => e.LinkHexes(hexA, hexB, adaptSecond ? LinkFit.AdaptSecond : LinkFit.Strict));

    public MeshCommandResultDto UnlinkFace(int sessionId, int hexId, string face) =>
        WithFace(sessionId, face, f => e => e.UnlinkFace(hexId, f));

    public MeshCommandResultDto MoveNode(int sessionId, int nodeId, MeshPointDto position, bool carryEdgeMidpoints) =>
        Command(sessionId, e => e.MoveNode(nodeId, new Vec3(position.X, position.Y, position.Z), carryEdgeMidpoints));

    public MeshCommandResultDto Smooth(int sessionId, int iterations, double relaxation, bool surface = false) =>
        Command(sessionId, e => e.Smooth(iterations, relaxation, surface));

    public MeshCommandResultDto Undo(int sessionId) => sessions.With(sessionId, e =>
    {
        bool ok = e.Undo();
        return new MeshCommandResultDto(ok, ok ? null : "Nothing to undo.", MeshStateMapper.ToDto(e));
    });

    public MeshCommandResultDto Redo(int sessionId) => sessions.With(sessionId, e =>
    {
        bool ok = e.Redo();
        return new MeshCommandResultDto(ok, ok ? null : "Nothing to redo.", MeshStateMapper.ToDto(e));
    });

    public MeshCommandResultDto Reset(int sessionId) => Command(sessionId, e => e.Reset());

    public void DropSession(int sessionId) => sessions.Remove(sessionId);

    public MeshMappingResultDto MapIdealToReal(int sessionId, MeshPointDto ideal) => sessions.With(sessionId, e =>
        e.Mesh.TryMapIdealToReal(new Vec3(ideal.X, ideal.Y, ideal.Z), out var real)
            ? new MeshMappingResultDto(true, new MeshPointDto(real.X, real.Y, real.Z))
            : new MeshMappingResultDto(false, null));

    public MeshMappingResultDto MapRealToIdeal(int sessionId, MeshPointDto real) => sessions.With(sessionId, e =>
        e.Mesh.TryMapRealToIdeal(new Vec3(real.X, real.Y, real.Z), out var ideal)
            ? new MeshMappingResultDto(true, new MeshPointDto(ideal.X, ideal.Y, ideal.Z))
            : new MeshMappingResultDto(false, null));

    private MeshCommandResultDto Command(int sessionId, Func<HexMeshEditor, EditResult> command) => sessions.With(sessionId, e =>
    {
        var result = command(e);
        return new MeshCommandResultDto(result.Ok, result.Error, MeshStateMapper.ToDto(e));
    });

    private MeshCommandResultDto WithFace(int sessionId, string face, Func<HexFace, Func<HexMeshEditor, EditResult>> build)
    {
        if (!MeshStateMapper.TryParseFace(face, out var parsed)) return Reject(sessionId, $"Unknown face \"{face}\".");
        return Command(sessionId, build(parsed));
    }

    private MeshCommandResultDto Reject(int sessionId, string error) =>
        sessions.With(sessionId, e => new MeshCommandResultDto(false, error, MeshStateMapper.ToDto(e)));
}
