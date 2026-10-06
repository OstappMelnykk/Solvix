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
            state.Hexes.Select(h => new MeshHexDto(h.Id, h.I, h.J, h.K, h.NodeIds)).ToList(),
            state.Links.Where(l => l.Hex < l.Other)
                .Select(l => new MeshLinkDto(l.Hex, l.Face.ToString(), l.Other, l.OtherFace.ToString(), mesh.IsSeam(l.Hex, l.Face))).ToList(),
            mesh.AllFaceStates().Select(f => new MeshFaceDto(
                f.Face.Hex, f.Face.Face.ToString(), f.Status.ToString(),
                f.Other?.Hex, f.Other?.Face.ToString(), f.Coincident, f.Gap, f.Seam)).ToList(),
            mesh.InvalidHexes());
    }

    public static bool TryParseFace(string name, out HexFace face) =>
        Enum.TryParse(name, ignoreCase: false, out face) && Enum.IsDefined(face);
}
