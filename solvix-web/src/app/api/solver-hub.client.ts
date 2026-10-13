import { Injectable } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { environment } from '../../environments/environment';
import { SolverJobDto } from './solver-api.service';

// The SignalR side of the solver: while a solve runs the server pushes `jobChanged` to the session's group.
// Kept behind this small class so the state service (and its tests) never touch the library.
@Injectable({ providedIn: 'root' })
export class SolverHubClient {
  private connection: HubConnection | null = null;
  private listener: ((sessionId: number, job: SolverJobDto) => void) | null = null;
  private joined = new Set<number>();

  // Calls back with every job change of the sessions joined so far.
  onJobChanged(listener: (sessionId: number, job: SolverJobDto) => void): void {
    this.listener = listener;
  }

  // Joins a session's group, connecting first if needed. Resolves false when the hub is unreachable (the
  // caller then polls instead).
  async join(sessionId: number): Promise<boolean> {
    try {
      const connection = await this.ensureConnected();
      if (!this.joined.has(sessionId)) {
        await connection.invoke('Join', sessionId);
        this.joined.add(sessionId);
      }
      return true;
    } catch {
      return false;
    }
  }

  async leave(sessionId: number): Promise<void> {
    this.joined.delete(sessionId);
    if (this.connection?.state === HubConnectionState.Connected) {
      try {
        await this.connection.invoke('Leave', sessionId);
      } catch {
        // the group is dropped with the connection anyway
      }
    }
  }

  private async ensureConnected(): Promise<HubConnection> {
    if (!this.connection) {
      this.connection = new HubConnectionBuilder()
        .withUrl(`${environment.apiBaseUrl}/hubs/solver`)
        .withAutomaticReconnect()
        .configureLogging(LogLevel.None)
        .build();
      this.connection.on('jobChanged', (...args: unknown[]) => {
        const [sessionId, job] = args as [number, SolverJobDto];
        this.listener?.(sessionId, job);
      });
      // after an automatic reconnect the server has forgotten the groups
      this.connection.onreconnected(async () => {
        for (const id of this.joined) {
          try {
            await this.connection?.invoke('Join', id);
          } catch {
            // ignored: polling covers it
          }
        }
      });
    }
    if (this.connection.state === HubConnectionState.Disconnected) {
      await this.connection.start();
    }
    return this.connection;
  }
}
