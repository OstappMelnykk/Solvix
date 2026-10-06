namespace Solvix.Contracts.Facades;

// The manual hex editor, per editing session (the client's session id). All
// geometry lives behind this interface; callers only exchange the DTOs above.
public interface IMeshBuilderFacade
{
    MeshStateDto GetState(int sessionId);

    /// <param name="shape">A designed cube to start from; the plain unit cube when null.</param>
    MeshCommandResultDto AddFirstHex(int sessionId, MeshShapeDto? shape = null);

    /// <param name="shape">A designed cube, fitted onto the face; a plain extrusion of the face when null.</param>
    MeshCommandResultDto AddHexOnFace(int sessionId, int hexId, string face, MeshShapeDto? shape = null);

    /// <param name="adaptSecond">Fit the second face onto the first before linking, instead of requiring them to coincide.</param>
    MeshCommandResultDto LinkFaces(int sessionId, int hexA, string faceA, int hexB, string faceB, bool adaptSecond);

    /// <summary>Deletes a cube; refused when the rest of the body would fall apart.</summary>
    MeshCommandResultDto RemoveHex(int sessionId, int hexId);

    /// <summary>Makes two lattice-adjacent hexes neighbours; the shared face is found, not named.</summary>
    MeshCommandResultDto LinkHexes(int sessionId, int hexA, int hexB, bool adaptSecond);

    MeshCommandResultDto UnlinkFace(int sessionId, int hexId, string face);

    /// <param name="carryEdgeMidpoints">A dragged corner also moves its edges' midpoints by half.</param>
    MeshCommandResultDto MoveNode(int sessionId, int nodeId, MeshPointDto position, bool carryEdgeMidpoints);

    MeshCommandResultDto Undo(int sessionId);

    MeshCommandResultDto Redo(int sessionId);

    MeshCommandResultDto Reset(int sessionId);

    /// <summary>Drops the session's mesh and history completely (the client closed or restarted the session).</summary>
    void DropSession(int sessionId);

    /// <summary>The ready-made shapes the constructor window offers.</summary>
    IReadOnlyList<MeshShapePresetDto> ShapePresets();

    /// <summary>Builds the 20 node positions of a parametric block (length/height/depth, taper, shear).</summary>
    MeshShapeDto BuildShape(MeshShapeParametersDto parameters);

    /// <summary>Whether a designed cube is a valid element (positive Jacobian everywhere).</summary>
    MeshShapeCheckDto CheckShape(MeshShapeDto shape);

    /// <summary>Ideal lattice point (units of one cell) to real space.</summary>
    MeshMappingResultDto MapIdealToReal(int sessionId, MeshPointDto ideal);

    /// <summary>Real point to ideal lattice units.</summary>
    MeshMappingResultDto MapRealToIdeal(int sessionId, MeshPointDto real);
}
