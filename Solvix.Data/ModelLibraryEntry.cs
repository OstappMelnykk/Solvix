namespace Solvix.Data;

// One uploaded model file, kept on the server so any session can import it
// later from a dropdown instead of everyone needing their own local copy of
// the same STL/GLB. The actual file bytes live on disk (ModelLibraryStorage's
// own concern) - this row is just the catalog entry: what the file is
// called, where to find it, and when it arrived.
public class ModelLibraryEntry
{
    public Guid Id { get; set; }

    // The name the uploader's own file had (e.g. "tooth.stl") - shown in the
    // dropdown and used to reconstruct a same-named File client-side after
    // download, so ModelImportService's extension-based loader dispatch
    // (geometry-file-loader.ts) still works unchanged.
    //
    // NOT the name the file is actually saved under on disk - that's this
    // row's own Id plus FileName's extension (ModelLibraryStorage), a
    // generated, collision-proof name derived from Id rather than stored
    // separately, so 2 uploads sharing a FileName ("tooth.stl" twice) can
    // never collide, and there's no second field that could ever drift out
    // of sync with how it's actually derived.
    public required string FileName { get; set; }

    public long SizeBytes { get; set; }

    public DateTimeOffset UploadedAt { get; set; }
}
