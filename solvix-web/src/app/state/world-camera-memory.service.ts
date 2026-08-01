import { Injectable, effect, inject } from '@angular/core';
import * as THREE from 'three';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';

export interface CameraState {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

// Remembers each session's camera angle, per World - same (sessionId,
// worldIndex) shape as WorldRepresentationService, but for camera state.
// Root-scoped and shared by all 3 WorldCanvasComponent instances (keyed by
// worldIndex) rather than living inside each component: previously each
// WorldCanvasComponent owned its own private KeyedStore + its own pruning
// effect() - a 4th copy of the same per-session-cleanup pattern that lived
// in a view class instead of alongside the other 3 (ActiveWorldService,
// SharedModelService, WorldRepresentationService), and couldn't be unit
// tested without a full component + WebGL context. Pulling it out here
// keeps all 4 session-keyed stores testable the same way.
@Injectable({ providedIn: 'root' })
export class WorldCameraMemoryService {
  private readonly sessions = inject(SessionsService);
  private readonly stateBySession = new KeyedStore<number, KeyedStore<number, CameraState>>();

  constructor() {
    // Drop a session's whole per-world camera map once it's actually closed.
    effect(() => {
      this.stateBySession.pruneTo(this.sessions.sessions().map(session => session.id));
    });
  }

  get(sessionId: number, worldIndex: number): CameraState | undefined {
    return this.worldStore(sessionId).get(worldIndex);
  }

  set(sessionId: number, worldIndex: number, state: CameraState): void {
    this.worldStore(sessionId).set(worldIndex, state);
  }

  private worldStore(sessionId: number): KeyedStore<number, CameraState> {
    return this.stateBySession.getOrCreate(sessionId, () => new KeyedStore());
  }
}