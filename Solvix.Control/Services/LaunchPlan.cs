using System.Text.Json;
using Solvix.Control.Models;

namespace Solvix.Control.Services;

// How one part of the stack should run.
public enum Method { Off, Docker, Script, Ide }

public sealed record LaunchPlan(Method Db, Method Backend, Method Frontend)
{
    public static readonly LaunchPlan AllDocker = new(Method.Docker, Method.Docker, Method.Docker);
    public static readonly LaunchPlan AllScript = new(Method.Docker, Method.Script, Method.Script);
    public static readonly LaunchPlan BackendInIde = new(Method.Docker, Method.Ide, Method.Script);
    public static readonly LaunchPlan AllInIde = new(Method.Docker, Method.Ide, Method.Ide);
    public static readonly LaunchPlan Nothing = new(Method.Off, Method.Off, Method.Off);
}

// One thing a plan needs: run a launcher command, or wait for the human to
// start something in their IDE (the panel cannot press Run in Rider).
public abstract record PlanStep(string Title);
public sealed record RunStep(string Title, string Arguments) : PlanStep(Title);
public sealed record WaitForIdeStep(string Title, string Component) : PlanStep(Title);
// Something running from an IDE/terminal that has to go before the plan can apply.
public sealed record ManualStopStep(string Title) : PlanStep(Title);

public sealed record PlanProblems(IReadOnlyList<string> Errors, IReadOnlyList<string> Warnings)
{
    public bool Ok => Errors.Count == 0;
}

public static class LaunchPlanner
{
    // What the stack looks like right now, in plan terms.
    public static LaunchPlan Current(StackSnapshot snap)
    {
        bool Up(ComponentRow r) => r.State != ComponentState.Down;

        var db = snap.Components.Any(c => c.Kind == ComponentKind.Database && Up(c)) ? Method.Docker : Method.Off;
        var backend = MethodOf(snap.Components.FirstOrDefault(c => c.Kind == ComponentKind.Api && Up(c)));
        var web = snap.Components.FirstOrDefault(c => c.Kind == ComponentKind.Web && Up(c));
        var dev = snap.Components.FirstOrDefault(c => c.Kind == ComponentKind.Frontend && Up(c));
        return new LaunchPlan(db, backend, web is not null ? Method.Docker : MethodOf(dev));
    }

    private static Method MethodOf(ComponentRow? row) => row switch
    {
        null => Method.Off,
        { Launcher.Kind: LauncherKind.Docker } => Method.Docker,
        { Launcher.Kind: LauncherKind.Script } => Method.Script,
        _ => Method.Ide,   // IDE, terminal, anything started outside the launcher
    };

    public static PlanProblems Validate(LaunchPlan plan)
    {
        var errors = new List<string>();
        var warnings = new List<string>();

        if (plan.Backend != Method.Off && plan.Db == Method.Off)
        {
            errors.Add("Backend потребує бази даних.");
        }
        // The api container publishes no port: the only way to reach it is through the web container's nginx.
        if (plan.Backend == Method.Docker && plan.Frontend != Method.Docker)
        {
            errors.Add("Backend у Docker доступний лише через Web у Docker - обери для Frontend теж Docker.");
        }
        // The web container proxies /api to the api container, and the dev frontend calls https://localhost:7153.
        if (plan.Frontend == Method.Docker && plan.Backend != Method.Docker)
        {
            errors.Add("Frontend у Docker працює лише з Backend у Docker.");
        }
        if (plan.Frontend is Method.Script or Method.Ide && plan.Backend == Method.Off)
        {
            warnings.Add("Frontend без Backend відкриється, але запити до API не працюватимуть.");
        }
        return new PlanProblems(errors, warnings);
    }

    // The steps that take the stack from `current` to `plan`: stops first, then starts.
    public static IReadOnlyList<PlanStep> Steps(LaunchPlan plan, LaunchPlan current)
    {
        var stops = new List<PlanStep>();
        var starts = new List<PlanStep>();

        void Stop(Method from, string name, string component)
        {
            switch (from)
            {
                case Method.Docker: AddOnce(stops, new RunStep("Зупинити api + web (Docker)", "down app")); break;
                case Method.Script: AddOnce(stops, new RunStep($"Зупинити {name} (скрипт)", "down " + component)); break;
                case Method.Ide: AddOnce(stops, new ManualStopStep($"Зупини {name} в IDE")); break;
            }
        }

        // Frontend and backend first, database last.
        if (current.Frontend != plan.Frontend) { Stop(current.Frontend, "Frontend", "fe"); }
        if (current.Backend != plan.Backend) { Stop(current.Backend, "Backend", "be"); }
        if (current.Db != plan.Db && plan.Db == Method.Off) { AddOnce(stops, new RunStep("Зупинити базу даних", "down db")); }

        if (plan.Db == Method.Docker && current.Db != Method.Docker) { starts.Add(new RunStep("Запустити базу даних", "up db")); }
        if (plan.Backend == Method.Docker || plan.Frontend == Method.Docker)
        {
            // api and web only exist together; `up app` is a no-op for what already runs.
            if (current.Backend != Method.Docker || current.Frontend != Method.Docker || stops.Count > 0)
            {
                starts.Add(new RunStep("Запустити api + web (Docker)", "up app"));
            }
        }
        if (plan.Backend == Method.Script && current.Backend != Method.Script) { starts.Add(new RunStep("Запустити Backend (скрипт)", "up be")); }
        if (plan.Frontend == Method.Script && current.Frontend != Method.Script) { starts.Add(new RunStep("Запустити Frontend (скрипт)", "up fe")); }
        if (plan.Backend == Method.Ide && current.Backend != Method.Ide) { starts.Add(new WaitForIdeStep("Запусти Backend в IDE", "Backend")); }
        if (plan.Frontend == Method.Ide && current.Frontend != Method.Ide) { starts.Add(new WaitForIdeStep("Запусти Frontend в IDE", "Frontend")); }

        return [.. stops, .. starts];
    }

    private static void AddOnce(List<PlanStep> steps, PlanStep step)
    {
        if (!steps.Contains(step))
        {
            steps.Add(step);
        }
    }
}

// Remembers the chosen plan across panel restarts.
public sealed class PlanStore(ControlPaths paths)
{
    private string File_ => Path.Combine(paths.StateDir, "plan.json");

    public LaunchPlan Load()
    {
        try
        {
            if (File.Exists(File_) && JsonSerializer.Deserialize<LaunchPlan>(File.ReadAllText(File_)) is { } plan)
            {
                return plan;
            }
        }
        catch (Exception e) when (e is IOException or JsonException) { }
        return LaunchPlan.AllScript;
    }

    public void Save(LaunchPlan plan)
    {
        try { File.WriteAllText(File_, JsonSerializer.Serialize(plan)); }
        catch (IOException) { }
    }
}
