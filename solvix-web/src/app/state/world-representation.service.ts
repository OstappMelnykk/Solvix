import { Injectable, effect, inject } from '@angular/core';
import * as THREE from 'three';
import { SharedModelService } from './shared-model.service';
import { SessionsService } from './sessions.service';
import { KeyedStore } from './keyed-store';

// What a World keeps about its own representation of a session's shared
// model. Shape intentionally undefined until real per-World representation
// logic exists - this is the seam, not the implementation.
export interface WorldData {}

// A World's view of the session's shared model: the Object3D to render,
// plus `data` - that specific World's own state about how it represents
// the model.
export interface WorldRepresentation {
  readonly object: THREE.Object3D;
  readonly data: WorldData | null;
}

// Each World represents a session's shared model in its own way, and each
// representation's own data is kept here, per (session, worldIndex) - NOT
// on the Object3D itself (its lifecycle is clone-per-canvas, see
// WorldCanvasComponent, so anything attached to it wouldn't survive a
// session switch) and NOT in SharedModelService (that's the one thing every
// World shares, this is what makes one World's view of it different).
//
// Root-scoped, like SharedModelService - the 3 WorldCanvasComponent
// instances are shared across sessions, so this can't live in a per-session
// DI scope. Nested KeyedStore: sessionId -> worldIndex -> WorldData,
// mirroring how a session owns its Worlds and each World owns its own data.
@Injectable({ providedIn: 'root' })
export class WorldRepresentationService {
  private readonly sessions = inject(SessionsService);
  private readonly shared = inject(SharedModelService);
  private readonly dataBySession = new KeyedStore<number, KeyedStore<number, WorldData>>();

  constructor() {
    // Drop a session's whole per-world data map once it's actually closed.
    effect(() => {
      this.dataBySession.pruneTo(this.sessions.sessions().map(session => session.id));
    });
  }

  // Placeholder: every world currently represents the model identically,
  // with no data of its own yet.
  getRepresentation(sessionId: number, worldIndex: number): WorldRepresentation {
    return {
      object: this.shared.getModel(sessionId),
      data: this.worldStore(sessionId).get(worldIndex) ?? null
    };
  }

  // Placeholder: seam for recording a world's own representation data.
  notifyModification(sessionId: number, worldIndex: number, data: WorldData): void {
    this.worldStore(sessionId).set(worldIndex, data);
  }

  private worldStore(sessionId: number): KeyedStore<number, WorldData> {
    return this.dataBySession.getOrCreate(sessionId, () => new KeyedStore());
  }
}