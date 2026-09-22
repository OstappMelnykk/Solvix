import { Injectable, signal } from '@angular/core';
import { readJson, writeJson } from './local-storage-json';

export interface Session {
  id: number;
  name: string;
}

interface PersistedSessions {
  readonly sessions: Session[];
  readonly nextId: number;
  readonly activeSessionId: number | null;
}

const STORAGE_KEY = 'solvix:sessions';

// The list of open sessions and which one is active. Everything else about
// a session (its Worlds' active tab, the shared model they work on) is
// keyed by sessionId in ActiveWorldService/SharedModelService instead -
// this service only tracks which sessions exist, not their content. When a
// session is removed here, those other services react to `sessions()`
// changing and prune their own entries for it (see KeyedStore.pruneTo) -
// this service doesn't need to know they exist.
@Injectable({ providedIn: 'root' })
export class SessionsService {
  private nextId: number;
  private readonly _sessions = signal<Session[]>([]);
  private readonly _activeSessionId = signal<number | null>(null);

  readonly sessions = this._sessions.asReadonly();
  // null means no session is open - RenderWindowComponent/SettingsPanelComponent
  // show an empty state instead (see AppComponent) rather than assuming one
  // always exists.
  readonly activeSessionId = this._activeSessionId.asReadonly();

  constructor() {
    // Reload-survival stand-in for a real backend (see
    // [[project_model_persistence]] - Solvix.Api has no endpoints yet).
    // This is the FIRST link in a whole chain of *StorageService-backed
    // localStorage reads (this file, ModelStorageService, ImportedGeometryStorageService,
    // VoxelizationStorageService, ZonePaintingStorageService,
    // SurfaceZonePaintingStorageService) - every one of those is keyed by
    // sessionId, so without restoring the SAME session ids here first (not
    // just always starting from one fresh blank session), none of the rest
    // of that data would ever be reachable again after a reload, even
    // though it's still sitting in localStorage.
    const persisted = readJson<PersistedSessions>(STORAGE_KEY);
    if (persisted && persisted.sessions.length > 0 && Number.isFinite(persisted.nextId)) {
      this.nextId = persisted.nextId;
      this._sessions.set(persisted.sessions);
      this._activeSessionId.set(persisted.activeSessionId);
    } else {
      this.nextId = 1;
      const session = this.createSessionEntry();
      this._sessions.set([session]);
      this._activeSessionId.set(session.id);
    }
  }

  createSession(): void {
    const session = this.createSessionEntry();
    this._sessions.update(sessions => [...sessions, session]);
    this._activeSessionId.set(session.id);
    this.persist();
  }

  selectSession(id: number): void {
    this._activeSessionId.set(id);
    this.persist();
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

    if (this._activeSessionId() === id) {
      if (remaining.length === 0) {
        this._activeSessionId.set(null);
      } else {
        const nextIndex = Math.min(closingIndex, remaining.length - 1);
        this._activeSessionId.set(remaining[nextIndex].id);
      }
    }
    this.persist();
  }

  private createSessionEntry(): Session {
    const id = this.nextId++;
    return { id, name: `Session ${id}` };
  }

  private persist(): void {
    writeJson(STORAGE_KEY, {
      sessions: this._sessions(),
      nextId: this.nextId,
      activeSessionId: this._activeSessionId()
    } satisfies PersistedSessions);
  }
}
