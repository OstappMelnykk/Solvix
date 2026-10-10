using Solvix.Contracts.Facades;
using Solvix.Mesh;

namespace Solvix.MeshBuilder;

internal static class MeshStateMapper
{
    public static MeshStateDto ToDto(HexMeshEditor editor)
    {
        var mesh = editor.Mesh;
        var state = mesh.ToState();
        return new MeshStateDto(
            editor.Version,
            editor.CanUndo,
            editor.CanRedo,
            state.Nodes.Select(n => new MeshNodeDto(n.Id, n.Position.X, n.Position.Y, n.Position.Z, n.IdealX, n.IdealY, n.IdealZ)).ToList(),
            state.Hexes.Select(h => new MeshHexDto(h.Id, h.I, h.J, h.K, h.NodeIds, h.Layer)).ToList(),
            state.Links.Where(l => l.Face.Sign() > 0)
                .Select(l => new MeshLinkDto(l.Hex, l.Face.ToString(), l.Other, l.Face.Opposite().ToString())).ToList(),
            mesh.AllFaceStates().Select(f => new MeshFaceDto(
                f.Face.Hex, f.Face.Face.ToString(), f.Status.ToString(),
                f.Other?.Hex, f.Other?.Face.ToString(), f.Coincident, f.Gap)).ToList(),
            mesh.InvalidHexes());
    }

    public static MeshShapeDto ToDto(HexShape shape) => new(shape.Positions.Select(p => new MeshPointDto(p.X, p.Y, p.Z)).ToList());

    // A missing shape is fine (null); a malformed one is reported, not thrown.
    public static bool TryShape(MeshShapeDto? dto, out HexShape? shape, out string? error)
    {
        shape = null;
        error = null;
        if (dto is null) return true;
        try
        {
            shape = new HexShape((dto.Positions ?? throw new ArgumentException("The shape has no positions.")).Select(p => new Vec3(p.X, p.Y, p.Z)));
            return true;
        }
        catch (ArgumentException exception)
        {
            error = exception.Message;
            return false;
        }
    }

    public static bool TryParseFace(string name, out HexFace face) =>
        Enum.TryParse(name, ignoreCase: false, out face) && Enum.IsDefined(face);
}
