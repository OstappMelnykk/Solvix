using Microsoft.Extensions.Options;

namespace Solvix.Api.ModelLibrary;

public class ModelLibraryStorageOptions
{
    // Where uploaded model files actually live on disk - a directory
    // mounted to its own Docker volume in production (docker-compose.yml)
    // so it survives container rebuilds/restarts the same way
    // postgres_data does for the database itself.
    public required string DirectoryPath { get; init; }
}

// The only piece of this feature that touches the filesystem - the
// controller only ever talks to this class for reads/writes, never to
// System.IO directly, so the one place a path gets built is also the one
// place that has to get it right.
public class ModelLibraryStorage(IOptions<ModelLibraryStorageOptions> options)
{
    // Not the full set ModelImportService's own GEOMETRY_FILE_LOADERS
    // support - if that ever grows, this needs updating too, but the
    // duplication is a small, deliberate price: this also closes a real
    // path-traversal hole. Path.GetExtension on a fully attacker-controlled
    // filename (e.g. "model.st../../../etc/passwd" - GetExtension returns
    // everything after the LAST '.', which here is
    // "../../../etc/passwd") would otherwise land straight in
    // Path.Combine below. Constraining it to a fixed allowlist instead of
    // "whatever came after the last dot" means the extension segment of
    // every stored filename is always one of these 2 literal strings, never
    // attacker-influenced beyond a yes/no membership check.
    private static readonly string[] AllowedExtensions = [".stl", ".glb"];

    private readonly string _directoryPath = options.Value.DirectoryPath;

    public bool TryGetSafeExtension(string originalFileName, out string extension)
    {
        extension = Path.GetExtension(originalFileName).ToLowerInvariant();
        return AllowedExtensions.Contains(extension);
    }

    // `id` (generated server-side, never client input) plus the already-
    // validated extension is the ENTIRE stored filename - deliberately not
    // derived from `originalFileName` beyond that, so 2 uploads that happen
    // to share a name never collide, and nothing about the path comes from
    // an untrusted string beyond the allowlisted extension.
    public async Task<long> SaveAsync(Guid id, string extension, Stream content, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_directoryPath);
        var fullPath = Path.Combine(_directoryPath, StoredFileNameFor(id, extension));
        await using var fileStream = File.Create(fullPath);
        await content.CopyToAsync(fileStream, cancellationToken);
        return fileStream.Length;
    }

    public Stream OpenRead(Guid id, string extension)
    {
        return File.OpenRead(Path.Combine(_directoryPath, StoredFileNameFor(id, extension)));
    }

    private static string StoredFileNameFor(Guid id, string extension) => $"{id:N}{extension}";
}
