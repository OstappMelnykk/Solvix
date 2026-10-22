using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;

namespace Solvix.Api.Control;

// Lets Solvix.Control (the admin panel) see this instance: who it is, how it
// was launched, how loaded it is, and what it logs. Entirely optional - with
// Control:Url empty nothing is registered, and a panel that is down or slow
// never affects the API: every call is short-timeout and failures are dropped.
public static class ControlReporting
{
    public static void AddControlReporting(this WebApplicationBuilder builder)
    {
        var url = builder.Configuration["Control:Url"];
        if (string.IsNullOrWhiteSpace(url))
        {
            return;
        }

        var identity = new InstanceIdentity(builder.Configuration["Control:Role"] ?? "api");
        builder.Services.AddSingleton(identity);
        var client = new ControlClient(url);
        builder.Services.AddSingleton(client);
        builder.Services.AddSingleton<RequestCounter>();
        builder.Services.AddHostedService<HeartbeatService>();

        var logs = new ControlLoggerProvider(identity, client);
        builder.Logging.AddProvider(logs);
    }

    public static void UseControlReporting(this WebApplication app)
    {
        if (app.Services.GetService<RequestCounter>() is { } counter)
        {
            app.Use(async (context, next) =>
            {
                counter.Begin();
                try { await next(context); }
                finally { counter.End(); }
            });
        }
    }
}

public sealed class InstanceIdentity(string role)
{
    public string Role { get; } = role;
    public int Pid { get; } = Environment.ProcessId;
    // In a container MachineName is the container id, so replicas get distinct ids for free.
    public string Id { get; } = $"{role}-{Environment.MachineName}-{Environment.ProcessId}";
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
}

public sealed class RequestCounter
{
    private long _total;
    private int _active;

    public long Total => Interlocked.Read(ref _total);
    public int Active => Volatile.Read(ref _active);

    public void Begin() { Interlocked.Increment(ref _total); Interlocked.Increment(ref _active); }
    public void End() => Interlocked.Decrement(ref _active);
}

public sealed class ControlClient(string baseUrl)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http = new() { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(2) };

    public async Task<bool> PostAsync<T>(string path, T body, CancellationToken ct = default)
    {
        try
        {
            using var response = await _http.PostAsJsonAsync(path, body, Json, ct);
            return response.IsSuccessStatusCode;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            return false;
        }
    }

    public async Task DeleteAsync(string path)
    {
        try { (await _http.DeleteAsync(path)).Dispose(); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { }
    }
}

// Registers on startup, then re-sends the same registration every few seconds:
// the panel treats it as a heartbeat, and learns about us again if it restarts.
public sealed class HeartbeatService(
    InstanceIdentity identity,
    ControlClient client,
    RequestCounter requests,
    IServer server,
    IHostApplicationLifetime lifetime,
    IWebHostEnvironment environment) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);
    private TimeSpan _lastCpu = Process.GetCurrentProcess().TotalProcessorTime;
    private DateTime _lastSample = DateTime.UtcNow;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var started = new TaskCompletionSource();
        lifetime.ApplicationStarted.Register(() => started.TrySetResult());
        await started.Task.WaitAsync(stoppingToken);

        using var timer = new PeriodicTimer(Interval);
        do
        {
            await client.PostAsync("/api/instances", Registration(), stoppingToken);
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        await client.DeleteAsync("/api/instances/" + Uri.EscapeDataString(identity.Id));
    }

    private object Registration()
    {
        using var process = Process.GetCurrentProcess();
        var now = DateTime.UtcNow;
        var cpu = process.TotalProcessorTime;
        var elapsed = (now - _lastSample).TotalSeconds;
        var cpuPercent = elapsed > 0 ? (cpu - _lastCpu).TotalSeconds / elapsed / Environment.ProcessorCount * 100 : 0;
        _lastCpu = cpu;
        _lastSample = now;

        return new
        {
            id = identity.Id,
            role = identity.Role,
            name = Environment.MachineName,
            pid = identity.Pid,
            launcher = Environment.GetEnvironmentVariable("SOLVIX_LAUNCHER"),   // script / docker; unset = started by an IDE or by hand
            host = Environment.MachineName,
            urls = server.Features.Get<IServerAddressesFeature>()?.Addresses.ToArray() ?? [],
            version = Assembly.GetEntryAssembly()?.GetName().Version?.ToString(3),
            environment = environment.EnvironmentName,
            startedAt = identity.StartedAt,
            metrics = new
            {
                workingSetMb = process.WorkingSet64 / 1024.0 / 1024.0,
                cpuPercent,
                threads = process.Threads.Count,
                requestsTotal = requests.Total,
                activeRequests = requests.Active,
            },
        };
    }
}

// Ships log records to the panel in small batches. The queue is bounded and
// drops the oldest entries when the panel is away, so logging can never grow
// memory or block a request.
public sealed class ControlLoggerProvider : ILoggerProvider
{
    private const int MaxQueued = 5_000;
    private const int BatchSize = 100;

    // Our own HTTP calls to the panel must not generate log records that
    // trigger more calls.
    private static readonly string[] Ignored = ["System.Net.Http", "Solvix.Api.Control"];

    private readonly InstanceIdentity _identity;
    private readonly ControlClient _client;
    private readonly ConcurrentQueue<object> _queue = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _pump;

    public ControlLoggerProvider(InstanceIdentity identity, ControlClient client)
    {
        _identity = identity;
        _client = client;
        _pump = Task.Run(PumpAsync);
    }

    public ILogger CreateLogger(string categoryName) =>
        Ignored.Any(categoryName.StartsWith) ? Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance
            : new ControlLogger(categoryName, this);

    internal void Enqueue(LogLevel level, string category, string message, Exception? exception)
    {
        _queue.Enqueue(new
        {
            time = DateTimeOffset.UtcNow,
            level = level.ToString(),
            category,
            message,
            exception = exception?.ToString(),
            instanceId = _identity.Id,
        });
        while (_queue.Count > MaxQueued)
        {
            _queue.TryDequeue(out _);
        }
    }

    private async Task PumpAsync()
    {
        var batch = new List<object>(BatchSize);
        while (!_stop.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(1), _stop.Token); }
            catch (OperationCanceledException) { break; }
            await FlushAsync(batch);
        }
        await FlushAsync(batch);
    }

    private async Task FlushAsync(List<object> batch)
    {
        while (!_queue.IsEmpty)
        {
            batch.Clear();
            while (batch.Count < BatchSize && _queue.TryDequeue(out var item))
            {
                batch.Add(item);
            }
            if (!await _client.PostAsync("/api/logs", batch))
            {
                return;   // panel unreachable: drop this batch, try again next second
            }
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        _pump.Wait(TimeSpan.FromSeconds(3));
    }

    private sealed class ControlLogger(string category, ControlLoggerProvider provider) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (IsEnabled(logLevel))
            {
                provider.Enqueue(logLevel, category, formatter(state, exception), exception);
            }
        }
    }
}
