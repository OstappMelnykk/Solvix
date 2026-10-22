namespace Solvix.Control.Models;

public sealed record InstanceMetrics(
    double WorkingSetMb,
    double CpuPercent,
    int Threads,
    long RequestsTotal,
    int ActiveRequests);

// What a running instance (Solvix.Api today, more replicas behind a load
// balancer later) reports about itself, on startup and then as a heartbeat.
public sealed record InstanceRegistration(
    string Id,
    string Role,
    string Name,
    int Pid,
    string? Launcher,
    string Host,
    string[] Urls,
    string? Version,
    string? Environment,
    DateTimeOffset StartedAt,
    InstanceMetrics? Metrics);

public enum InstanceHealth { Alive, Unresponsive }

public sealed record InstanceView(
    InstanceRegistration Info,
    DateTimeOffset LastSeen,
    InstanceHealth Health,
    double RequestsPerSecond);
