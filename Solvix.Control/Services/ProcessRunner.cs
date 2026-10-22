using System.Diagnostics;

namespace Solvix.Control.Services;

public sealed record ProcessResult(int ExitCode, string Output, string Error)
{
    public bool Success => ExitCode == 0;
}

public interface IProcessRunner
{
    Task<ProcessResult> RunAsync(
        string file,
        IEnumerable<string> args,
        TimeSpan timeout,
        IReadOnlyDictionary<string, string>? env = null,
        Action<string>? onLine = null,
        CancellationToken ct = default);
}

public sealed class ProcessRunner : IProcessRunner
{
    // A GUI-launched process (IDE, launchd) often has a PATH without Homebrew,
    // where docker/colima live.
    private static readonly string[] ExtraPath = ["/opt/homebrew/bin", "/usr/local/bin"];

    public async Task<ProcessResult> RunAsync(
        string file,
        IEnumerable<string> args,
        TimeSpan timeout,
        IReadOnlyDictionary<string, string>? env = null,
        Action<string>? onLine = null,
        CancellationToken ct = default)
    {
        var info = new ProcessStartInfo(file)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
        };
        foreach (var arg in args)
        {
            info.ArgumentList.Add(arg);
        }
        info.Environment["PATH"] = string.Join(':', ExtraPath.Append(info.Environment["PATH"] ?? ""));
        foreach (var (key, value) in env ?? new Dictionary<string, string>())
        {
            info.Environment[key] = value;
        }

        Process process;
        try
        {
            process = Process.Start(info) ?? throw new InvalidOperationException("process did not start");
        }
        catch (Exception e)
        {
            return new ProcessResult(-1, "", $"{file}: {e.Message}");
        }

        using (process)
        {
            process.StandardInput.Close();
            var output = new System.Text.StringBuilder();
            var error = new System.Text.StringBuilder();
            process.OutputDataReceived += (_, e) => Collect(e.Data, output, onLine);
            process.ErrorDataReceived += (_, e) => Collect(e.Data, error, onLine);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);
            try
            {
                await process.WaitForExitAsync(cts.Token);
                process.WaitForExit();   // flush the async output readers
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                return new ProcessResult(-2, output.ToString(), error + "\ntimeout");
            }
            return new ProcessResult(process.ExitCode, output.ToString(), error.ToString());
        }
    }

    private static void Collect(string? line, System.Text.StringBuilder sink, Action<string>? onLine)
    {
        if (line is null)
        {
            return;
        }
        lock (sink)
        {
            sink.AppendLine(line);
        }
        onLine?.Invoke(line);
    }
}
