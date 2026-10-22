namespace Solvix.Control.Models;

public sealed record LogEntry(
    DateTimeOffset Time,
    string Level,
    string Category,
    string Message,
    string? Exception,
    string InstanceId);

public sealed record LogFilter(
    string MinLevel = "Trace",
    string? InstanceId = null,
    string? Text = null,
    int Take = 500);

public static class LogLevels
{
    public static readonly string[] All = ["Trace", "Debug", "Information", "Warning", "Error", "Critical"];

    public static int Rank(string level) => level switch
    {
        "Trace" => 0,
        "Debug" => 1,
        "Information" or "Info" => 2,
        "Warning" or "Warn" => 3,
        "Error" => 4,
        "Critical" or "Fatal" => 5,
        _ => 2,
    };
}
