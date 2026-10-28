using System.Text.Json;

namespace Solvix.Control.Services;

// How the terminal window looks, as remembered by the browser. Reading it back
// is tolerant on purpose: whatever is in localStorage (missing keys, nulls,
// wrong types, garbage) must never break the page.
public sealed record TerminalLook(string Font, int Size, int Height, int? Width, int X, int Y)
{
    public const string DefaultFont = "ui-monospace, 'SF Mono', Menlo, monospace";

    public static readonly TerminalLook Default = new(DefaultFont, 13, 460, null, 0, 0);

    public static TerminalLook Parse(string? json, IReadOnlyCollection<string> knownFonts)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return Default;
        }
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return Default;
            }
            var font = root.TryGetProperty("font", out var f) && f.ValueKind == JsonValueKind.String
                && f.GetString() is { } name && knownFonts.Contains(name) ? name : DefaultFont;
            return new TerminalLook(
                font,
                Math.Clamp(Number(root, "size") ?? Default.Size, 9, 28),
                Math.Clamp(Number(root, "height") ?? Default.Height, 160, 4000),
                // null (or missing) means "the full available width".
                Number(root, "width") is { } width ? Math.Clamp(width, 320, 8000) : null,
                Math.Clamp(Number(root, "x") ?? 0, -4000, 4000),
                Math.Clamp(Number(root, "y") ?? 0, -4000, 4000));
        }
        catch (JsonException)
        {
            return Default;
        }
    }

    public string ToJson() => JsonSerializer.Serialize(new { font = Font, size = Size, height = Height, width = Width, x = X, y = Y });

    private static int? Number(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
            ? number : null;
}
