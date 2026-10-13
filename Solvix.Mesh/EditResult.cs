namespace Solvix.Mesh;

/// <summary>Outcome of one editing command. On failure nothing has changed.</summary>
public sealed record EditResult(bool Ok, string? Error, string? Info = null)
{
    public static EditResult Success { get; } = new(true, null);
    /// <summary>A success with something to tell the user (what the command did).</summary>
    public static EditResult Done(string info) => new(true, null, info);
    public static EditResult Fail(string error) => new(false, error);
}
