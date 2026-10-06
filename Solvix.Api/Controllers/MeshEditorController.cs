using Microsoft.AspNetCore.Mvc;
using Solvix.Contracts.Facades;

namespace Solvix.Api.Controllers;

public record LinkFacesRequest(int HexA, string FaceA, int HexB, string FaceB, bool AdaptSecond);

public record LinkHexesRequest(int HexA, int HexB, bool AdaptSecond);

public record MoveNodeRequest(double X, double Y, double Z, bool CarryEdgeMidpoints = false);

/// <summary>
/// Manual hex editor, one mesh per client session. Every editing command
/// answers 200 with <c>{ ok, error, state }</c> - a refused command is a normal
/// outcome (<c>ok: false</c>, state unchanged), not an HTTP error - so the
/// client always has the current state to draw. Faces are named XMinus, XPlus,
/// YMinus, YPlus, ZMinus, ZPlus.
/// </summary>
[ApiController]
[Route("api/mesh-editor/{sessionId:int}")]
public class MeshEditorController(IMeshBuilderFacade meshBuilder) : ControllerBase
{
    /// <summary>Forgets the session's mesh and undo history (the client closed or restarted it).</summary>
    [HttpDelete]
    public IActionResult DropSession(int sessionId)
    {
        meshBuilder.DropSession(sessionId);
        return NoContent();
    }

    [HttpGet("state")]
    public ActionResult<MeshStateDto> GetState(int sessionId) => meshBuilder.GetState(sessionId);

    [HttpPost("hexes/first")]
    public ActionResult<MeshCommandResultDto> AddFirstHex(int sessionId) => meshBuilder.AddFirstHex(sessionId);

    [HttpPost("hexes/{hexId:int}/faces/{face}/attach")]
    public ActionResult<MeshCommandResultDto> AddHexOnFace(int sessionId, int hexId, string face) =>
        meshBuilder.AddHexOnFace(sessionId, hexId, face);

    [HttpDelete("hexes/{hexId:int}")]
    public ActionResult<MeshCommandResultDto> RemoveHex(int sessionId, int hexId) => meshBuilder.RemoveHex(sessionId, hexId);

    [HttpPost("links")]
    public ActionResult<MeshCommandResultDto> LinkFaces(int sessionId, [FromBody] LinkFacesRequest request) =>
        meshBuilder.LinkFaces(sessionId, request.HexA, request.FaceA, request.HexB, request.FaceB, request.AdaptSecond);

    [HttpPost("links/by-hexes")]
    public ActionResult<MeshCommandResultDto> LinkHexes(int sessionId, [FromBody] LinkHexesRequest request) =>
        meshBuilder.LinkHexes(sessionId, request.HexA, request.HexB, request.AdaptSecond);

    [HttpDelete("hexes/{hexId:int}/faces/{face}/link")]
    public ActionResult<MeshCommandResultDto> UnlinkFace(int sessionId, int hexId, string face) =>
        meshBuilder.UnlinkFace(sessionId, hexId, face);

    [HttpPut("nodes/{nodeId:int}")]
    public ActionResult<MeshCommandResultDto> MoveNode(int sessionId, int nodeId, [FromBody] MoveNodeRequest request) =>
        meshBuilder.MoveNode(sessionId, nodeId, new MeshPointDto(request.X, request.Y, request.Z), request.CarryEdgeMidpoints);

    [HttpPost("undo")]
    public ActionResult<MeshCommandResultDto> Undo(int sessionId) => meshBuilder.Undo(sessionId);

    [HttpPost("redo")]
    public ActionResult<MeshCommandResultDto> Redo(int sessionId) => meshBuilder.Redo(sessionId);

    [HttpPost("reset")]
    public ActionResult<MeshCommandResultDto> Reset(int sessionId) => meshBuilder.Reset(sessionId);

    [HttpPost("map/ideal-to-real")]
    public ActionResult<MeshMappingResultDto> MapIdealToReal(int sessionId, [FromBody] MeshPointDto point) =>
        meshBuilder.MapIdealToReal(sessionId, point);

    [HttpPost("map/real-to-ideal")]
    public ActionResult<MeshMappingResultDto> MapRealToIdeal(int sessionId, [FromBody] MeshPointDto point) =>
        meshBuilder.MapRealToIdeal(sessionId, point);
}
