using Solvix.Control.Components;
using Solvix.Control.Models;
using Solvix.Control.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));

builder.Services.AddRazorComponents().AddInteractiveServerComponents();

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ControlPaths>();
builder.Services.AddSingleton<IProcessRunner, ProcessRunner>();
builder.Services.AddSingleton<InstanceRegistry>();
builder.Services.AddSingleton<LogStore>();
builder.Services.AddSingleton<DockerProbe>();
builder.Services.AddSingleton<HostProbe>();
builder.Services.AddSingleton<RawLogReader>();
builder.Services.AddSingleton<ActionRunner>();
builder.Services.AddSingleton<TerminalService>();
builder.Services.AddSingleton<StackMonitor>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<StackMonitor>());

var app = builder.Build();

// The panel can start and stop the stack and run docker commands: only answer
// to localhost names (DNS rebinding) and refuse cross-site connections to the
// Blazor circuit (a web page you visit must not be able to drive it).
app.Use(async (context, next) =>
{
    var host = context.Request.Host.Host;
    if (host is not ("localhost" or "127.0.0.1" or "[::1]" or "::1" or "host.docker.internal"))
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    if (context.Request.Path.StartsWithSegments("/_blazor")
        && context.Request.Headers.Origin.ToString() is { Length: > 0 } origin
        && !(Uri.TryCreate(origin, UriKind.Absolute, out var originUri) && originUri.Host == host))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }
    await next(context);
});

app.UseStaticFiles();
app.UseAntiforgery();

// Ingest API - what Solvix.Api (and later every replica) talks to.
app.MapPost("/api/instances", (InstanceRegistration registration, InstanceRegistry registry) =>
{
    registry.Upsert(registration);
    return Results.NoContent();
});
app.MapDelete("/api/instances/{id}", (string id, InstanceRegistry registry) =>
    registry.Remove(id) ? Results.NoContent() : Results.NotFound());
app.MapPost("/api/logs", (LogEntry[] batch, LogStore logs) =>
{
    logs.Add(batch);
    return Results.NoContent();
});

// Machine-readable state, for scripts and for a load balancer to read later.
app.MapGet("/api/stack", (StackMonitor monitor) => monitor.Current);
app.MapGet("/health", () => "ok");

app.MapRazorComponents<App>().AddInteractiveServerRenderMode();

app.Run();

// Lets Solvix.Control.Tests host the app in-process.
public partial class Program;
