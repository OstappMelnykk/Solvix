import { Injectable, WritableSignal, effect, inject, signal } from '@angular/core';
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

  private entry(sessionId: number): WritableSignal<number> {
    return this.indexBySession.getOrCreate(sessionId, () => signal(0));
  }
}