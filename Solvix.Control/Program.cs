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
builder.Services.AddSingleton<StackMonitor>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<StackMonitor>());

var app = builder.Build();

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
