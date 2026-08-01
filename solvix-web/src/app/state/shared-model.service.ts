import { Injectable, InjectionToken, effect, inject } from '@angular/core';
import * as THREE from 'three';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';

export type ModelFactory = () => THREE.Object3D;

// What a brand-new session's model starts out as. A token, not something
// hardcoded inside SharedModelService - whoever composes the app can swap
// it (provide a different INITIAL_MODEL_FACTORY in app.config.ts) without
// touching this file at all. Default is a placeholder box; this is the
// seam for eventually loading a real per-session dataset instead.
export const INITIAL_MODEL_FACTORY = new InjectionToken<ModelFactory>('INITIAL_MODEL_FACTORY', {
  providedIn: 'root',
  factory: (): ModelFactory => () =>
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3574f0 }))
});

// The one model every World represents for a given session. `THREE.Object3D`
// is deliberately the most general Three.js "thing that goes into a scene"
// type - not BufferGeometry, since a real model will eventually be a whole
// group of hexahedra (their own geometry/material/position each), not a
// single shape with one shared material.
//
// Root-scoped and keyed by sessionId: there are only 3 WorldCanvasComponent
// instances for the whole app (one per World, shared across sessions), so
// each session's model has to be stored here rather than in a per-session
// component scope - switching sessions swaps which model those 3 shared
// canvases draw, without recreating any WebGL context.
@Injectable({ providedIn: 'root' })
export class SharedModelService {
  private readonly sessions = inject(SessionsService);
  private readonly createInitialModel = inject(INITIAL_MODEL_FACTORY);
  private readonly modelBySession = new KeyedStore<number, THREE.Object3D>();

  constructor() {
    // Once a session actually closes, dispose its model's GPU resources
    // (geometry/material) before dropping the reference - otherwise every
    // closed session leaks VRAM forever.
    effect(() => {
      this.modelBySession.pruneTo(
        this.sessions.sessions().map(session => session.id),
        model => this.disposeModel(model)
      );
    });
  }

  getModel(sessionId: number): THREE.Object3D {
    return this.modelBySession.getOrCreate(sessionId, this.createInitialModel);
  }

  private disposeModel(model: THREE.Object3D): void {
    model.traverse(child => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    });
  }
}