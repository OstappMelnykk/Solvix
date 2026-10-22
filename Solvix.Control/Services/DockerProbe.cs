using System.Text.Json;
using Solvix.Control.Models;

namespace Solvix.Control.Services;

public sealed record DockerContainer(
    string Id,
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
    public DockerContainer? Service(string project, string service) =>
        Containers.FirstOrDefault(c => c.Project == project && c.Service == service);

    // Numbers of the Docker environments (compose projects "solvix-<N>") that exist, stopped or not.
    public IReadOnlyList<int> StackIds() =>
        Containers.Select(c => DockerProbe.StackIdOf(c.Project)).Where(id => id is not null)
            .Select(id => id!.Value).Distinct().Order().ToList();
}

public sealed class DockerProbe(IProcessRunner runner)
{
    public const string DevProject = "solvix-dev";

    public static string StackProject(int id) => $"solvix-{id}";

    public static int? StackIdOf(string project) =>
        project.StartsWith("solvix-") && int.TryParse(project.AsSpan("solvix-".Length), out var id) ? id : null;

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
                    Text(root, "ID"),
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
