using Solvix.Control.Models;

namespace Solvix.Control.Services;

// Plain-text output of a component, for the ones that can't push structured
// logs: files the launcher script writes, and docker containers.
public sealed class RawLogReader(ControlPaths paths, DockerProbe docker)
{
    public async Task<string> TailAsync(string source, int lines = 300, CancellationToken ct = default)
    {
        switch (source)
        {
            case "db":
                return await DockerAsync("postgres", lines, ct);
            case "api":
            case "web":
                return await DockerAsync(source, lines, ct);
            case "be" or "fe":
                var file = Path.Combine(paths.LogDir, source + ".log");
                return File.Exists(file)
                    ? string.Join('\n', await ReadTailAsync(file, lines, ct))
                    : "Логу ще немає: компонент не запускався через ./scripts/solvix.";
            case "panel":
                return "Панель пише свої події в журнал (вкладка «Логи», інстанс «panel»).";
            default:
                return "Невідоме джерело.";
        }
    }

    private async Task<string> DockerAsync(string service, int lines, CancellationToken ct)
    {
        var name = $"{DockerProbe.Project}-{service}-1";
        var result = await docker.LogsAsync(name, lines, ct);
        var text = (result.Output + result.Error).TrimEnd();
        return text.Length > 0 ? text : $"Порожньо (контейнер {name} не запущений або без виводу).";
    }

    private static async Task<IEnumerable<string>> ReadTailAsync(string file, int lines, CancellationToken ct)
    {
        // Shared read: the launcher's process keeps the file open for writing.
        await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        var all = new Queue<string>();
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            all.Enqueue(line);
            if (all.Count > lines)
            {
                all.Dequeue();
            }
        }
        return all;
    }
}
