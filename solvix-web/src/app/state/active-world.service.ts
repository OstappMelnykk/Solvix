import { Injectable, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';

// Which World tab (Ideal/Real/Solver) is open - remembered per session, but
// the service itself is root-scoped: there are only 3 WorldCanvasComponent
// instances for the whole app (one per World), shared by every session, so
// there's no per-session component subtree left to scope this to. Each
// session gets its own entry in the store instead.
@Injectable({ providedIn: 'root' })
export class ActiveWorldService {
  private readonly sessions = inject(SessionsService);
  private readonly indexBySession = new KeyedStore<number, WritableSignal<number>>();

  // Resolves the active World index for whichever session is currently
  // active - `null` when no session is open. The single source of truth for
  // this null-safe lookup, so consumers (RenderWindowComponent,
  // WorldTabsComponent, SettingsPanelComponent) all read the same computed
  // instead of each re-deriving it (and each picking its own sentinel).
  readonly currentWorldIndex = computed(() => {
    const sessionId = this.sessions.activeSessionId();
    return sessionId === null ? null : this.activeWorldIndex(sessionId)();
  });

  constructor() {
    // Drop a session's entry once it's actually closed (SessionsService no
    // longer lists it) - otherwise this store grows forever.
    effect(() => {
      this.indexBySession.pruneTo(this.sessions.sessions().map(session => session.id));
    });
  }

  activeWorldIndex(sessionId: number) {
    return this.entry(sessionId).asReadonly();
  }

  selectWorld(sessionId: number, index: number): void {
    this.entry(sessionId).set(index);
  }

  // Same as selectWorld, but resolved against whichever session is
  // currently active - a no-op when no session is open.
  selectCurrentWorld(index: number): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null) {
      return;
    }
    this.selectWorld(sessionId, index);
  }

  private entry(sessionId: number): WritableSignal<number> {
    return this.indexBySession.getOrCreate(sessionId, () => signal(0));
  }
}