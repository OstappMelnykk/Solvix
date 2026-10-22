using System.Text.Json;
using Solvix.Control.Models;

namespace Solvix.Control.Services;

public sealed record DockerContainer(
    string Name,
    string Service,
    string Project,
    string Image,
    string State,
    string Status,
    string Ports)
{
    public bool Running => State == "running";
    // Status looks like "Up 2 minutes (healthy)" / "Up 5 seconds (health: starting)".
    public bool Healthy => Running && !Status.Contains("unhealthy") && !Status.Contains("starting");
}

public sealed record DockerSnapshot(bool Available, IReadOnlyList<DockerContainer> Containers)
{
    public IEnumerable<DockerContainer> OfProject(string project) =>
        Containers.Where(c => c.Project == project);

    public DockerContainer? Service(string project, string service) =>
        OfProject(project).FirstOrDefault(c => c.Service == service);
}

public sealed class DockerProbe(IProcessRunner runner)
{
    public const string Project = "solvix";

    public async Task<DockerSnapshot> CaptureAsync(CancellationToken ct = default)
    {
        var result = await runner.RunAsync(
            "docker", ["ps", "-a", "--format", "{{json .}}"], TimeSpan.FromSeconds(8), ct: ct);
        return result.Success
            ? new DockerSnapshot(true, ParseContainers(result.Output))
            : new DockerSnapshot(false, []);
    }

    public Task<ProcessResult> LogsAsync(string container, int tail, CancellationToken ct = default) =>
        runner.RunAsync("docker", ["logs", "--tail", tail.ToString(), "--timestamps", container], TimeSpan.FromSeconds(10), ct: ct);

    public static List<DockerContainer> ParseContainers(string output)
    {
        var result = new List<DockerContainer>();
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                var labels = ParseLabels(Text(root, "Labels"));
                result.Add(new DockerContainer(
                    Text(root, "Names"),
                    labels.GetValueOrDefault("com.docker.compose.service", ""),
                    labels.GetValueOrDefault("com.docker.compose.project", ""),
                    Text(root, "Image"),
                    Text(root, "State"),
                    Text(root, "Status"),
                    Text(root, "Ports")));
            }
            catch (JsonException)
            {
                // Skip a malformed line rather than lose the whole listing.
            }
        }
        return result;
    }

    private static string Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) ? value.GetString() ?? "" : "";

    private static Dictionary<string, string> ParseLabels(string labels) =>
        labels.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair => pair.Split('=', 2))
            .Where(parts => parts.Length == 2)
            .GroupBy(parts => parts[0])
            .ToDictionary(g => g.Key, g => g.First()[1]);
}
