using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Solvix.Api.ModelLibrary;
using Solvix.Data;

namespace Solvix.Api.Controllers;

// One shared catalog of previously-uploaded model files, kept on the server
// so any session can pull one into its own Ideal World from a dropdown
// instead of everyone needing their own local copy of the same STL/GLB. Two
// separate steps by design (per the user's own request, not merged into
// one "import" action): upload adds a file to this catalog; a session
// later imports FROM the catalog by id, same as picking a local file
// through ModelImportService (solvix-web's own geometry/model-import.service.ts)
// once the bytes are back on the client.
public record ModelLibraryEntryDto(Guid Id, string FileName, long SizeBytes, DateTimeOffset UploadedAt);

[ApiController]
[Route("api/model-library")]
public class ModelLibraryController(SolvixDbContext db, ModelLibraryStorage storage, ILogger<ModelLibraryController> logger) : ControllerBase
{
    // Same cap as MeshesController's own voxelize endpoint - these are the
    // exact same kind of file (an STL/GLB reference mesh), just archived
    // here instead of voxelized immediately.
    private const long MaxUploadBytes = 300_000_000;

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken cancellationToken)
    {
        var entries = await db.ModelLibraryEntries
            .OrderByDescending(entry => entry.UploadedAt)
            .Select(entry => new ModelLibraryEntryDto(entry.Id, entry.FileName, entry.SizeBytes, entry.UploadedAt))
            .ToListAsync(cancellationToken);
        return Ok(entries);
    }

    // Binary body, not a multipart form upload - same "raw bytes, filename
    // out of band" shape as MeshesController.Voxelize, just with the name
    // carried as a query parameter (?fileName=...) instead of implied by a
    // fixed content type, since this endpoint has to accept more than one
    // format.
    [HttpPost]
    [RequestSizeLimit(MaxUploadBytes)]
    [Consumes("application/octet-stream")]
    public async Task<IActionResult> Upload([FromQuery] string fileName, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return BadRequest(new { Message = "fileName query parameter is required." });
        }
        if (!storage.TryGetSafeExtension(fileName, out var extension))
        {
            return BadRequest(new { Message = $"Unsupported file extension for \"{fileName}\" - only .stl and .glb are accepted." });
        }

        var id = Guid.NewGuid();
        long sizeBytes;
        using (var body = new MemoryStream())
        {
            // Same "buffer the non-seekable request stream first" reasoning
            // as MeshesController.Voxelize - AllowSynchronousIO is off by
            // default, and this needs a definite length up front regardless.
            await Request.Body.CopyToAsync(body, cancellationToken);
            body.Position = 0;
            sizeBytes = await storage.SaveAsync(id, extension, body, cancellationToken);
        }

        var entry = new ModelLibraryEntry
        {
            Id = id,
            FileName = fileName,
            SizeBytes = sizeBytes,
            UploadedAt = DateTimeOffset.UtcNow
        };
        db.ModelLibraryEntries.Add(entry);
        await db.SaveChangesAsync(cancellationToken);

        logger.LogInformation("Stored model library entry {Id} ({FileName}, {SizeBytes} bytes)", entry.Id, entry.FileName, entry.SizeBytes);
        return Ok(new ModelLibraryEntryDto(entry.Id, entry.FileName, entry.SizeBytes, entry.UploadedAt));
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Download(Guid id, CancellationToken cancellationToken)
    {
        var entry = await db.ModelLibraryEntries.FirstOrDefaultAsync(candidate => candidate.Id == id, cancellationToken);
        if (entry is null)
        {
            return NotFound();
        }
        // FileName was already validated against the extension allowlist at
        // upload time (TryGetSafeExtension above) - safe to re-derive here
        // without re-validating.
        var extension = Path.GetExtension(entry.FileName);
        var stream = storage.OpenRead(id, extension);
        return File(stream, "application/octet-stream");
    }
}
