namespace Solvix.Contracts.Facades;

// The manual hex editor, per editing session (the client's session id). All
// geometry lives behind this interface; callers only exchange the DTOs above.
public interface IMeshBuilderFacade
{
    MeshStateDto GetState(int sessionId);

    MeshCommandResultDto AddFirstHex(int sessionId);

    MeshCommandResultDto AddHexOnFace(int sessionId, int hexId, string face);

    /// <param name="adaptSecond">Fit the second face onto the first before linking, instead of requiring them to coincide.</param>
    MeshCommandResultDto LinkFaces(int sessionId, int hexA, string faceA, int hexB, string faceB, bool adaptSecond);

    MeshCommandResultDto UnlinkFace(int sessionId, int hexId, string face);

    /// <param name="carryEdgeMidpoints">A dragged corner also moves its edges' midpoints by half.</param>
    MeshCommandResultDto MoveNode(int sessionId, int nodeId, MeshPointDto position, bool carryEdgeMidpoints);

    MeshCommandResultDto Undo(int sessionId);

    MeshCommandResultDto Redo(int sessionId);

    MeshCommandResultDto Reset(int sessionId);

    /// <summary>Ideal lattice point (units of one cell) to real space.</summary>
    MeshMappingResultDto MapIdealToReal(int sessionId, MeshPointDto ideal);

    /// <summary>Real point to ideal lattice units.</summary>
    MeshMappingResultDto MapRealToIdeal(int sessionId, MeshPointDto real);
}
