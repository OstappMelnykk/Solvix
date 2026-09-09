using Microsoft.AspNetCore.Mvc;
using Solvix.Contracts.Facades;
using Solvix.MeshBuilder;

namespace Solvix.Api.Controllers;

[ApiController]
[Route("api/meshes")]
public class MeshesController(IMeshBuilderFacade meshBuilder) : ControllerBase
{
    // Binary body/response, not JSON - see Solvix.MeshBuilder for why. This
    // controller never touches mesh/voxel-grid shapes directly - it only
    // knows HTTP concerns (request size, content type, status codes);
    // everything about the wire format and the algorithm is
    // IMeshBuilderFacade's business.
    [HttpPost("voxelize")]
    [RequestSizeLimit(300_000_000)]
    [Consumes("application/octet-stream")]
    public async Task<IActionResult> Voxelize()
    {
        // Request.Body is a non-seekable network stream that doesn't allow
        // synchronous reads (AllowSynchronousIO is off by default) - buffer
        // it into memory first.
        using var body = new MemoryStream();
        await Request.Body.CopyToAsync(body);

        try
        {
            var response = meshBuilder.Voxelize(body.ToArray());
            return new FileContentResult(response, "application/octet-stream");
        }
        catch (MeshTooLargeException error)
        {
            return BadRequest(new { error.CellCount, error.Limit });
        }
    }
}