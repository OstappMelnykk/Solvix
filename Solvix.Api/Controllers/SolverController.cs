using Microsoft.AspNetCore.Mvc;
using Solvix.Contracts.Facades;

namespace Solvix.Api.Controllers;

public record HexMaterialRequest(IReadOnlyList<int> HexIds, string? Material);

public record DefaultMaterialRequest(string Material);

/// <param name="Replace">When true, exactly these faces become the clamped ones (<c>Fixed</c> is ignored).</param>
public record FixedFacesRequest(IReadOnlyList<SolverFaceDto> Faces, bool Fixed, bool Replace = false);

public record DivisionsRequest(int Nx, int Ny, int Nz);

public record ElementMaterialRequest(IReadOnlyList<SolverElementDto> Elements, string? Material);

/// <param name="Replace">When true (with a pressure), exactly these faces carry it, replacing every earlier pressure.</param>
public record LoadFacesRequest(IReadOnlyList<SolverFaceDto> Faces, double? Pressure, bool Replace = false);

/// <summary>
/// The FEM solver for one session: what to solve (materials, supports, pressures), whether it can be solved,
/// the background solve and its result. Progress is also pushed over SignalR (<c>/hubs/solver</c>, group per
/// session, message <c>jobChanged(sessionId, job)</c>). Pressure is the solver's Pn in Pa: along the outward normal, negative = compression.
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

    /// <summary>How many small elements each cube is cut into along its axes (the solver's Nx, Ny, Nz; 1..8 each).</summary>
    [HttpPut("divisions")]
    public ActionResult<SolverSetupDto> SetDivisions(int sessionId, [FromBody] DivisionsRequest request) =>
        solver.SetDivisions(sessionId, request.Nx, request.Ny, request.Nz);

    /// <summary>Gives small elements of divided cubes a material of their own; a null or empty name makes them follow their cube again.</summary>
    [HttpPut("elements/material")]
    public ActionResult<SolverSetupDto> SetElementMaterial(int sessionId, [FromBody] ElementMaterialRequest request) =>
        solver.SetElementMaterial(sessionId, request.Elements, request.Material);

    /// <summary>Gives cubes a material; a null or empty name returns them to the default one.</summary>
    [HttpPut("hexes/material")]
    public ActionResult<SolverSetupDto> SetHexMaterial(int sessionId, [FromBody] HexMaterialRequest request) =>
        solver.SetHexMaterial(sessionId, request.HexIds, request.Material);

    [HttpPut("faces/fixed")]
    public ActionResult<SolverSetupDto> SetFixedFaces(int sessionId, [FromBody] FixedFacesRequest request) =>
        request.Replace ? solver.ReplaceFixedFaces(sessionId, request.Faces) : solver.SetFixedFaces(sessionId, request.Faces, request.Fixed);

    /// <summary>Sets a uniform pressure on faces; a null pressure removes it.</summary>
    [HttpPut("faces/load")]
    public ActionResult<SolverSetupDto> SetLoads(int sessionId, [FromBody] LoadFacesRequest request) =>
        request.Replace && request.Pressure is double p ? solver.ReplaceLoads(sessionId, request.Faces, p) : solver.SetLoads(sessionId, request.Faces, request.Pressure);

    /// <summary>Takes back the last change of the set-up (the supports, pressures, materials, division).</summary>
    [HttpPost("setup/undo")]
    public ActionResult<SolverSetupDto> UndoSetup(int sessionId) => solver.UndoSetup(sessionId);

    [HttpPost("setup/redo")]
    public ActionResult<SolverSetupDto> RedoSetup(int sessionId) => solver.RedoSetup(sessionId);

    [HttpDelete("setup")]
    public ActionResult<SolverSetupDto> ClearSetup(int sessionId) => solver.ClearSetup(sessionId);

    [HttpPost("validate")]
    public ActionResult<SolverValidationDto> Validate(int sessionId) => bridge.Validate(sessionId);

    /// <summary>How well the mesh, cut at the current division, can be integrated: grades per cube and overall.</summary>
    [HttpGet("quality")]
    public ActionResult<SolverQualityReportDto> Quality(int sessionId) => bridge.Quality(sessionId);

    /// <summary>The details of one small element: how every standard judges it, with its value of every measure.</summary>
    [HttpGet("quality/element")]
    public ActionResult<SolverElementReportDto> QualityOfElement(int sessionId, [FromQuery] int hex, [FromQuery] int ex, [FromQuery] int ey, [FromQuery] int ez) =>
        bridge.QualityOfElement(sessionId, hex, ex, ey, ez) is { } report ? report : NotFound();

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
