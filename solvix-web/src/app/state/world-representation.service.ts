import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';
import { SharedModelService } from './shared-model.service';

// A World's view of the session's shared model: the Object3D to render,
// plus `data` - whatever that specific World keeps about how it represents
// the model. `data`'s real shape is undefined until the backend contract
// exists; this is the seam, not the implementation.
export interface WorldRepresentation {
  readonly object: THREE.Object3D;
  readonly data: unknown;
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
// DI scope.
@Injectable({ providedIn: 'root' })
export class WorldRepresentationService {
  private readonly shared = inject(SharedModelService);
  private readonly dataByKey = new Map<string, unknown>();

  // Placeholder: every world currently represents the model identically,
  // with no data of its own yet.
  getRepresentation(sessionId: number, worldIndex: number): WorldRepresentation {
    return {
      object: this.shared.getModel(sessionId),
      data: this.dataByKey.get(this.key(sessionId, worldIndex)) ?? null
    };
  }

  // Placeholder: seam for recording a world's own representation data.
  notifyModification(sessionId: number, worldIndex: number, data: unknown): void {
    this.dataByKey.set(this.key(sessionId, worldIndex), data);
  }

  private key(sessionId: number, worldIndex: number): string {
    return `${sessionId}:${worldIndex}`;
  }
}