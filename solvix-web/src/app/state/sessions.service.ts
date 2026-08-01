import { Injectable, signal } from '@angular/core';

export interface Session {
  id: number;
  name: string;
}

// The list of open sessions and which one is active. Everything else about
// a session (its Worlds' active tab, the shared model they work on) is
// keyed by sessionId in ActiveWorldService/SharedModelService instead -
// this service only tracks which sessions exist, not their content. When a
// session is removed here, those other services react to `sessions()`
// changing and prune their own entries for it (see KeyedStore.pruneTo) -
// this service doesn't need to know they exist.
@Injectable({ providedIn: 'root' })
export class SessionsService {
  private nextId = 1;
  private readonly _sessions = signal<Session[]>([this.createSessionEntry()]);
  private readonly _activeSessionId = signal<number | null>(this._sessions()[0].id);

  readonly sessions = this._sessions.asReadonly();
  // null means no session is open - RenderWindowComponent/SettingsPanelComponent
  // show an empty state instead (see AppComponent) rather than assuming one
  // always exists.
  readonly activeSessionId = this._activeSessionId.asReadonly();

  createSession(): void {
    const session = this.createSessionEntry();
    this._sessions.update(sessions => [...sessions, session]);
    this._activeSessionId.set(session.id);
  }

  selectSession(id: number): void {
    this._activeSessionId.set(id);
  }

  // Any session can be closed, including the last one - the rest of the
  // app is built to tolerate zero open sessions (see activeSessionId).
  closeSession(id: number): void {
    const sessions = this._sessions();
    const closingIndex = sessions.findIndex(session => session.id === id);
    if (closingIndex === -1) {
      return;
    }

    const remaining = sessions.filter(session => session.id !== id);
    this._sessions.set(remaining);

    if (this._activeSessionId() !== id) {
      return;
    }
    if (remaining.length === 0) {
      this._activeSessionId.set(null);
      return;
    }
    const nextIndex = Math.min(closingIndex, remaining.length - 1);
    this._activeSessionId.set(remaining[nextIndex].id);
  }

  private createSessionEntry(): Session {
    const id = this.nextId++;
    return { id, name: `Session ${id}` };
  }
}