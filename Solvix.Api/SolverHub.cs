using Microsoft.AspNetCore.SignalR;
using Solvix.Contracts.Facades;

namespace Solvix.Api;

/// <summary>Clients join the group of their session and receive <c>jobChanged</c> while a solve runs.</summary>
public class SolverHub : Hub
{
    public static string Group(int sessionId) => $"session-{sessionId}";

    public Task Join(int sessionId) => Groups.AddToGroupAsync(Context.ConnectionId, Group(sessionId));

    public Task Leave(int sessionId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, Group(sessionId));
}

internal sealed class SignalRSolverNotifier(IHubContext<SolverHub> hub) : ISolverProgressNotifier
{
    public Task JobChanged(int sessionId, SolverJobDto job) => hub.Clients.Group(SolverHub.Group(sessionId)).SendAsync("jobChanged", job);
}
