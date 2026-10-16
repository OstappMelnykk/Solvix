using Microsoft.AspNetCore.Mvc;
using Solvix.Contracts.Facades;

namespace Solvix.Api.Controllers;

public record HexMaterialRequest(IReadOnlyList<int> HexIds, string? Material);

public record DefaultMaterialRequest(string Material);

/// <param name="Replace">When true, exactly these faces become the clamped ones (<c>Fixed</c> is ignored).</param>
public record FixedFacesRequest(IReadOnlyList<SolverFaceDto> Faces, bool Fixed, bool Replace = false);

public record DivisionsRequest(int Nx, int Ny, int Nz);

/// <param name="Action">"fix", "unfix", "load" (with Pressure) or "unload".</param>
public record SelectFacesRequest(IReadOnlyList<ElementFaceRefDto> Faces, string Action, double? Pressure = null);

public record PaintElementsRequest(IReadOnlyList<string> ElementKeys, string? Material);

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

    [HttpDelete("materials/{name}")]
    public ActionResult<SolverSetupDto> RemoveMaterial(int sessionId, string name) => solver.RemoveMaterial(sessionId, name);

    [HttpPut("default-material")]
    public ActionResult<SolverSetupDto> SetDefaultMaterial(int sessionId, [FromBody] DefaultMaterialRequest request) =>
        solver.SetDefaultMaterial(sessionId, request.Material);

    /// <summary>How many small elements each cube is cut into along its axes (the solver's Nx, Ny, Nz; 1..8 each).</summary>
    [HttpPut("divisions")]
    public ActionResult<SolverSetupDto> SetDivisions(int sessionId, [FromBody] DivisionsRequest request) =>
        solver.SetDivisions(sessionId, request.Nx, request.Ny, request.Nz);

    /// <summary>
    /// Refines the body locally: the leaves of the step (the keys the mesh gives them) are cut into NI x NJ x NK, the cells round them by transition templates.
    /// 400 when the step cannot be done (nothing named, a bad number, nothing left to refine, too fine).
    /// </summary>
    [HttpPost("refinement")]
    public ActionResult<SolverSetupDto> AddLocalRefinement(int sessionId, [FromBody] RefinementStepDto step)
    {
        try { return bridge.AddLocalRefinement(sessionId, step); }
        catch (ArgumentException exception) { return BadRequest(new { error = exception.Message }); }
    }

    /// <summary>Takes the whole local refinement away.</summary>
    [HttpDelete("refinement")]
    public ActionResult<SolverSetupDto> ClearLocalRefinement(int sessionId) => solver.ClearLocalRefinement(sessionId);

    /// <summary>The mesh of finite elements as it would be solved - nodes, elements, the faces on the surface - with the materials, clamps and pressures set on it.</summary>
    [HttpGet("mesh")]
    public ActionResult<SolverMeshDto> GetMesh(int sessionId) => bridge.GetMesh(sessionId);

    /// <summary>Clamps, unclamps, presses or clears the pressure of exactly the faces of the mesh that were pointed at (faces named by element key and local face).</summary>
    [HttpPut("mesh/faces")]
    public ActionResult<SolverSetupDto> SelectFaces(int sessionId, [FromBody] SelectFacesRequest request) =>
        bridge.SelectFaces(sessionId, request.Faces, request.Action, request.Pressure);

    /// <summary>Gives exactly the elements of the mesh that were pointed at (named by key) a material.</summary>
    [HttpPut("mesh/elements/material")]
    public ActionResult<SolverSetupDto> PaintElements(int sessionId, [FromBody] PaintElementsRequest request) =>
        bridge.PaintElements(sessionId, request.ElementKeys, request.Material);

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

    /// <summary>The details of one element named by its key.</summary>
    [HttpGet("quality/element-by-key")]
    public ActionResult<SolverElementReportDto> QualityOfElementByKey(int sessionId, [FromQuery] string key) =>
        bridge.QualityOfElementByKey(sessionId, key) is { } report ? report : NotFound();

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
