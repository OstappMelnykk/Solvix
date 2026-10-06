namespace Solvix.Mesh;

/// <summary>Outcome of one editing command. On failure nothing has changed.</summary>
public sealed record EditResult(bool Ok, string? Error)
{
    public static EditResult Success { get; } = new(true, null);
    public static EditResult Fail(string error) => new(false, error);
}
