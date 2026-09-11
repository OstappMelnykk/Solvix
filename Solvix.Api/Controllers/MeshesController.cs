using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Solvix.Contracts.Facades;
using Solvix.MeshBuilder;

namespace Solvix.Api.Controllers;

[ApiController]
[Route("api/meshes")]
public class MeshesController(IMeshBuilderFacade meshBuilder, ILogger<MeshesController> logger) : ControllerBase
{
    // ~140MB for the real 2.9M-triangle STL that was ~690MB as JSON (see
    // Solvix.Voxelization's MeshBinarySerializer) - leaves headroom for a
    // heavier import while still bounding just this one action's request
    // body, rather than raising Kestrel's default limit for every endpoint.
    private const long MaxRequestBodyBytes = 300_000_000;

    // Binary body/response, not JSON - see Solvix.MeshBuilder for why. This
    // controller never touches mesh/voxel-grid shapes directly - it only
    // knows HTTP concerns (request size, content type, status codes);
    // everything about the wire format and the algorithm is
    // IMeshBuilderFacade's business.
    [HttpPost("voxelize")]
    [RequestSizeLimit(MaxRequestBodyBytes)]
    [Consumes("application/octet-stream")]
    /// <param name="cancellationToken">
    /// Auto-bound by ASP.NET Core to <c>HttpContext.RequestAborted</c> - if
    /// the client disconnects mid-request, this cancels both the body-read
    /// and the voxelization work itself instead of computing a result
    /// nobody will receive.
    /// </param>
    /// <returns>
    /// <c>200 OK</c> with the voxel grid as an
    /// <c>application/octet-stream</c> body (see
    /// <c>VoxelizationResultBinarySerializer</c> for its layout) on success;
    /// <c>400 BadRequest</c> with <c>{CellCount, Limit}</c> if the mesh
    /// would need too many cells, or <c>{Message}</c> if the mesh body
    /// itself is malformed.
    /// </returns>
    /// <remarks>
    /// Reads the raw mesh bytes from <c>Request.Body</c> (the binary format
    /// documented in <c>Solvix.Voxelization.MeshBinarySerializer</c>) - this
    /// controller never inspects or names that shape itself, only HTTP
    /// concerns (size limit, content type, status codes).
    /// </remarks>
    public async Task<IActionResult> Voxelize(CancellationToken cancellationToken)
    {
        // Request.Body is a non-seekable network stream that doesn't allow
        // synchronous reads (AllowSynchronousIO is off by default) - buffer
        // it into memory first.
        using var body = new MemoryStream();
        await Request.Body.CopyToAsync(body, cancellationToken);
        var requestBytes = body.ToArray();

        var stopwatch = Stopwatch.StartNew();
        try
        {
            // Voxelize() is a synchronous, CPU-bound computation (up to
            // MaxCells worth of triangle-vs-box tests) - running it
            // directly on this async method's thread would tie up an
            // ASP.NET Core request-processing thread for the whole
            // duration. Task.Run hands it to the thread pool instead, and
            // `cancellationToken` (auto-bound to HttpContext.RequestAborted
            // by ASP.NET Core) lets a client that disconnects mid-request
            // actually stop the computation early (see the
            // ThrowIfCancellationRequested check in VoxelizationService's
            // main loop) rather than just abandoning an HTTP response
            // nobody reads while the work keeps running to completion.
            var response = await Task.Run(() => meshBuilder.Voxelize(requestBytes, cancellationToken), cancellationToken);
            logger.LogInformation(
                "Voxelized {RequestBytes} bytes into a {ResponseBytes}-byte grid in {ElapsedMs}ms",
                requestBytes.Length, response.Length, stopwatch.ElapsedMilliseconds);
            return new FileContentResult(response, "application/octet-stream");
        }
        catch (MeshTooLargeException error)
        {
            logger.LogWarning(
                "Rejected a {RequestBytes}-byte mesh: {CellCount} cells exceeds the {Limit} limit",
                requestBytes.Length, error.CellCount, error.Limit);
            return BadRequest(new { error.CellCount, error.Limit });
        }
        catch (InvalidMeshException error)
        {
            logger.LogWarning(error, "Rejected a malformed {RequestBytes}-byte mesh body", requestBytes.Length);
            return BadRequest(new { error.Message });
        }
    }
}