import { Injectable, signal } from '@angular/core';

export interface Session {
  id: number;
  name: string;
}

// The list of open sessions and which one is active. Everything else about
// a session (its Worlds, their active tab, the shared model they work on)
// lives in a separate, per-session DI scope created by SessionComponent -
// this service only tracks which sessions exist, not their content.
@Injectable({ providedIn: 'root' })
export class SessionsService {
  private nextId = 1;
  private readonly _sessions = signal<Session[]>([this.createSessionEntry()]);
  private readonly _activeSessionId = signal(this._sessions()[0].id);

  readonly sessions = this._sessions.asReadonly();
  readonly activeSessionId = this._activeSessionId.asReadonly();

  createSession(): void {
    const session = this.createSessionEntry();
    this._sessions.update(sessions => [...sessions, session]);
    this._activeSessionId.set(session.id);
  }

  selectSession(id: number): void {
    this._activeSessionId.set(id);
  }

  private createSessionEntry(): Session {
    const id = this.nextId++;
    return { id, name: `Session ${id}` };
  }
}