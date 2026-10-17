using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Solvix.Contracts.Facades;

namespace Solvix.Api.Controllers;

public record LinkFacesRequest(int HexA, string FaceA, int HexB, string FaceB, bool AdaptSecond);

public record LinkHexesRequest(int HexA, int HexB, bool AdaptSecond);

public record AttachRequest(MeshShapeDto? Shape, MeshCellDto? Cell = null);

public record MoveNodeRequest(double X, double Y, double Z, bool CarryEdgeMidpoints = false);

public record MoveFaceRequest(double Dx, double Dy, double Dz);

public record MoveNodesRequest(IReadOnlyList<NodeMoveDto>? Moves);

/// <summary>
/// Manual hex editor, one mesh per client session. Every editing command
/// answers 200 with <c>{ ok, error, state }</c> - a refused command is a normal
/// outcome (<c>ok: false</c>, state unchanged), not an HTTP error - so the
/// client always has the current state to draw. Faces are named XMinus, XPlus,
/// YMinus, YPlus, ZMinus, ZPlus.
/// </summary>
[ApiController]
[Route("api/mesh-editor/{sessionId:int}")]
public class MeshEditorController(IMeshBuilderFacade meshBuilder, ISolverFacade solver) : ControllerBase
{
    /// <summary>Forgets the session's mesh and undo history (the client closed or restarted it).</summary>
    [HttpDelete]
    public IActionResult DropSession(int sessionId)
    {
        meshBuilder.DropSession(sessionId);
        solver.DropSession(sessionId);
        return NoContent();
    }

    /// <summary>
    /// The outer skin of the body as a binary STL file. <c>density</c> (1..64, default 8) is how many squares each outer face is cut into per side;
    /// the headers <c>X-Shell-Faces</c>, <c>X-Shell-Triangles</c> and <c>X-Shell-Deviation</c> say what came out.
    /// </summary>
    [HttpGet("shell.stl")]
    public IActionResult ExportShell(int sessionId, [FromQuery] int density = 8)
    {
        var shell = meshBuilder.ExportShell(sessionId, density);
        if (shell is null) return BadRequest($"Nothing to export: the density must be 1..64 and the mesh must have cubes.");
        Response.Headers["X-Shell-Faces"] = shell.Faces.ToString();
        Response.Headers["X-Shell-Triangles"] = shell.Triangles.ToString();
        Response.Headers["X-Shell-Deviation"] = shell.MaxDeviation.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        return File(shell.Stl, "model/stl", "shell.stl");
    }

    [HttpGet("state")]
    public ActionResult<MeshStateDto> GetState(int sessionId) => meshBuilder.GetState(sessionId);

    /// <summary>Adds a template body (pipe, sphere...) as a separate part; one undo step.</summary>
    [HttpPost("bodies")]
    public ActionResult<MeshCommandResultDto> AddTemplate(int sessionId, [FromBody] MeshTemplateRequestDto request) =>
        meshBuilder.AddTemplate(sessionId, request);

    /// <summary>Starts the body; the optional body <c>{ shape, cell }</c>: a designed cube (otherwise the unit cube) and the lattice cell to put it in (otherwise 0, 0, 0).</summary>
    [HttpPost("hexes/first")]
    public ActionResult<MeshCommandResultDto> AddFirstHex(int sessionId, [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] AttachRequest? request = null) =>
        meshBuilder.AddFirstHex(sessionId, request?.Shape, request?.Cell);

    /// <summary>Adds a cube on a face; the optional body <c>{ shape }</c> is a designed cube fitted onto the face (otherwise a plain extrusion).</summary>
    [HttpPost("hexes/{hexId:int}/faces/{face}/attach")]
    public ActionResult<MeshCommandResultDto> AddHexOnFace(int sessionId, int hexId, string face, [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] AttachRequest? request = null) =>
        meshBuilder.AddHexOnFace(sessionId, hexId, face, request?.Shape);

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

    /// <summary>Puts several nodes at the given places in one undo step: <c>{ moves: [{ nodeId, x, y, z }] }</c>.</summary>
    [HttpPut("nodes")]
    public ActionResult<MeshCommandResultDto> MoveNodes(int sessionId, [FromBody] MoveNodesRequest request) =>
        meshBuilder.MoveNodes(sessionId, request.Moves ?? Array.Empty<NodeMoveDto>());

    /// <summary>Moves a whole face by one displacement <c>{ dx, dy, dz }</c> (one undo step).</summary>
    [HttpPut("hexes/{hexId:int}/faces/{face}/move")]
    public ActionResult<MeshCommandResultDto> MoveFace(int sessionId, int hexId, string face, [FromBody] MoveFaceRequest request) =>
        meshBuilder.MoveFace(sessionId, hexId, face, new MeshPointDto(request.Dx, request.Dy, request.Dz));

    /// <summary>Moves a whole edge (index 0..11) by one displacement <c>{ dx, dy, dz }</c> (one undo step).</summary>
    [HttpPut("hexes/{hexId:int}/edges/{edge:int}/move")]
    public ActionResult<MeshCommandResultDto> MoveEdge(int sessionId, int hexId, int edge, [FromBody] MoveFaceRequest request) =>
        meshBuilder.MoveEdge(sessionId, hexId, edge, new MeshPointDto(request.Dx, request.Dy, request.Dz));

    [HttpPost("undo")]
    public ActionResult<MeshCommandResultDto> Undo(int sessionId) => meshBuilder.Undo(sessionId);

    [HttpPost("redo")]
    public ActionResult<MeshCommandResultDto> Redo(int sessionId) => meshBuilder.Redo(sessionId);

    [HttpPost("reset")]
    public ActionResult<MeshCommandResultDto> Reset(int sessionId)
    {
        // hex ids start again from 0, so supports and loads set for the old cubes must not apply to the new ones
        solver.ClearSetup(sessionId);
        return meshBuilder.Reset(sessionId);
    }

    [HttpPost("map/ideal-to-real")]
    public ActionResult<MeshMappingResultDto> MapIdealToReal(int sessionId, [FromBody] MeshPointDto point) =>
        meshBuilder.MapIdealToReal(sessionId, point);

    [HttpPost("map/real-to-ideal")]
    public ActionResult<MeshMappingResultDto> MapRealToIdeal(int sessionId, [FromBody] MeshPointDto point) =>
        meshBuilder.MapRealToIdeal(sessionId, point);
}
