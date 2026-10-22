using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Solvix.Control.Models;
using Solvix.Control.Services;

namespace Solvix.Control.Tests;

public class TerminalTests
{
    private sealed class FakeRunner : IProcessRunner
    {
        public string? File { get; private set; }
        public IReadOnlyList<string> Args { get; private set; } = [];
        public IReadOnlyDictionary<string, string>? Env { get; private set; }

        public Task<ProcessResult> RunAsync(string file, IEnumerable<string> args, TimeSpan timeout,
            IReadOnlyDictionary<string, string>? env = null, Action<string>? onLine = null, CancellationToken ct = default, string? workingDirectory = null)
        {
            File = file; Args = args.ToList(); Env = env;
            onLine?.Invoke("line one");
            return Task.FromResult(new ProcessResult(0, "line one", ""));
        }
    }

    private static readonly string Root = Path.Combine(Path.GetTempPath(), "solvix-term-tests");

    private static (TerminalService Term, FakeRunner Runner) Create()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Control:RepoRoot"] = Root }).Build();
        var runner = new FakeRunner();
        var paths = new ControlPaths(config);
        return (new TerminalService(paths, new CommandPolicy(paths), runner, TimeProvider.System, NullLogger<TerminalService>.Instance), runner);
    }

    [Test]
    public void Tokenize_respects_quotes_and_does_not_interpret_shell_syntax()
    {
        Assert.That(TerminalService.Tokenize("docker logs --tail 5 \"my box\""),
            Is.EqualTo(new[] { "docker", "logs", "--tail", "5", "my box" }));
        Assert.That(TerminalService.Tokenize("docker ps; rm -rf /"),
            Is.EqualTo(new[] { "docker", "ps;", "rm", "-rf", "/" }));
    }

    [TestCase("rm -rf /")]
    [TestCase("bash -c ls")]
    [TestCase("docker rm x")]
    [TestCase("")]
    public void Only_safe_commands_are_accepted(string line)
    {
        var (term, _) = Create();

        Assert.That(term.Parse(line, out var error), Is.Null);
        Assert.That(error, Is.Not.Null);
    }

    [Test]
    public async Task Solvix_commands_run_the_launcher_script_and_keep_the_panel_alive()
    {
        var (term, runner) = Create();

        await term.RunAsync("solvix stack up 1");

        Assert.That(runner.File, Is.EqualTo(Path.Combine(Root, "scripts", "solvix")));
        Assert.That(runner.Args, Is.EqualTo(new[] { "stack", "up", "1" }));
        Assert.That(runner.Env!["SOLVIX_KEEP_PANEL"], Is.EqualTo("1"));
        Assert.That(term.Lines.Select(l => l.Text), Does.Contain("line one"));
        Assert.That(term.History, Is.EqualTo(new[] { "solvix stack up 1" }));
    }

    [Test]
    public async Task Rejected_command_is_reported_in_the_output_and_never_run()
    {
        var (term, runner) = Create();

        await term.RunAsync("curl evil.example");

        Assert.That(runner.File, Is.Null);
        Assert.That(term.Lines.Any(l => l.Kind == TermKind.Error), Is.True);
        Assert.That(term.Busy, Is.False);
    }
}

public class TerminalLookTests
{
    private static readonly string[] Fonts = [TerminalLook.DefaultFont, "Menlo, monospace"];

    [Test]
    public void Full_width_is_saved_as_null_and_reads_back_without_error()
    {
        // This exact shape crashed the page once: "width": null from a full-width window.
        var saved = new TerminalLook(TerminalLook.DefaultFont, 13, 460, null, 0, 0).ToJson();

        var look = TerminalLook.Parse(saved, Fonts);

        Assert.That(look.Width, Is.Null);
        Assert.That(look.Height, Is.EqualTo(460));
    }

    [Test]
    public void Saved_look_round_trips()
    {
        var original = new TerminalLook("Menlo, monospace", 16, 700, 900, 40, -20);

        Assert.That(TerminalLook.Parse(original.ToJson(), Fonts), Is.EqualTo(original));
    }

    [TestCase(null)]
    [TestCase("")]
    [TestCase("not json")]
    [TestCase("[1,2]")]
    [TestCase("{\"size\":\"big\",\"height\":null,\"width\":\"wide\",\"x\":{},\"font\":42}")]
    public void Garbage_falls_back_to_the_defaults(string? json)
    {
        Assert.That(TerminalLook.Parse(json, Fonts), Is.EqualTo(TerminalLook.Default));
    }

    [Test]
    public void Out_of_range_values_are_clamped_and_unknown_fonts_ignored()
    {
        var look = TerminalLook.Parse("{\"font\":\"Comic Sans\",\"size\":500,\"height\":1,\"width\":5,\"x\":99999,\"y\":-99999}", Fonts);

        Assert.That(look.Font, Is.EqualTo(TerminalLook.DefaultFont));
        Assert.That((look.Size, look.Height, look.Width, look.X, look.Y), Is.EqualTo((28, 160, (int?)320, 4000, -4000)));
    }
}
