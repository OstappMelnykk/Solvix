using Microsoft.AspNetCore.Mvc;
using Solvix.Contracts.Facades;

namespace Solvix.Api.Controllers;

public record HexMaterialRequest(IReadOnlyList<int> HexIds, string? Material);

public record DefaultMaterialRequest(string Material);

public record FixedFacesRequest(IReadOnlyList<SolverFaceDto> Faces, bool Fixed);

public record LoadFacesRequest(IReadOnlyList<SolverFaceDto> Faces, double? Pressure);

/// <summary>
/// The FEM solver for one session: what to solve (materials, supports, pressures), whether it can be solved,
/// the background solve and its result. Progress is also pushed over SignalR (<c>/hubs/solver</c>, group per
/// session, message <c>jobChanged(sessionId, job)</c>). Pressure is in Pa, positive = pressing into the body.
/// </summary>
[ApiController]
[Route("api/solver/{sessionId:int}")]
public class SolverController(ISolverFacade solver, Bridge.Bridge bridge) : ControllerBase
{
    [HttpGet("setup")]
    public ActionResult<SolverSetupDto> GetSetup(int sessionId) => solver.GetSetup(sessionId);

    [HttpPut("materials")]
    public ActionResult<SolverSetupDto> UpsertMaterial(int sessionId, [FromBody] SolverMaterialDto material) => solver.UpsertMaterial(sessionId, material);

    [HttpPut("default-material")]
    public ActionResult<SolverSetupDto> SetDefaultMaterial(int sessionId, [FromBody] DefaultMaterialRequest request) =>
        solver.SetDefaultMaterial(sessionId, request.Material);

    /// <summary>Gives cubes a material; a null or empty name returns them to the default one.</summary>
    [HttpPut("hexes/material")]
    public ActionResult<SolverSetupDto> SetHexMaterial(int sessionId, [FromBody] HexMaterialRequest request) =>
        solver.SetHexMaterial(sessionId, request.HexIds, request.Material);

    [HttpPut("faces/fixed")]
    public ActionResult<SolverSetupDto> SetFixedFaces(int sessionId, [FromBody] FixedFacesRequest request) =>
        solver.SetFixedFaces(sessionId, request.Faces, request.Fixed);

    /// <summary>Sets a uniform pressure on faces; a null pressure removes it.</summary>
    [HttpPut("faces/load")]
    public ActionResult<SolverSetupDto> SetLoads(int sessionId, [FromBody] LoadFacesRequest request) =>
        solver.SetLoads(sessionId, request.Faces, request.Pressure);

    [HttpDelete("setup")]
    public ActionResult<SolverSetupDto> ClearSetup(int sessionId) => solver.ClearSetup(sessionId);

    [HttpPost("validate")]
    public ActionResult<SolverValidationDto> Validate(int sessionId) => bridge.Validate(sessionId);

    [HttpPost("solve")]
    public ActionResult<SolverJobDto> Solve(int sessionId) => bridge.StartSolve(sessionId);

    [HttpGet("job")]
    public ActionResult<SolverJobDto> GetJob(int sessionId) => solver.GetJob(sessionId);

    [HttpPost("cancel")]
    public ActionResult<SolverJobDto> Cancel(int sessionId) => solver.CancelSolve(sessionId);

    /// <summary>The last finished solve, or 404 when there is none.</summary>
    [HttpGet("result")]
    public ActionResult<SolverResultDto> GetResult(int sessionId)
    {
        var result = solver.GetResult(sessionId);
        return result is null ? NotFound() : result;
    }
}
