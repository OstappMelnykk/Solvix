import { Injectable, InjectionToken, effect, inject } from '@angular/core';
import * as THREE from 'three';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { ModelStorageService } from './model-storage.service';

export type ModelFactory = () => THREE.Object3D;

// What a brand-new session's model starts out as. A token, not something
// hardcoded inside SharedModelService - whoever composes the app can swap
// it (provide a different INITIAL_MODEL_FACTORY in app.config.ts) without
// touching this file at all. Default is an empty group - a new session has
// nothing placed yet (no real geometry pipeline writes into this model
// currently; an earlier placeholder cube had nothing to do with any
// session's actual data and was only ever a stand-in for "something is
// here"). This is the seam for eventually loading a real per-session
// dataset instead.
export const INITIAL_MODEL_FACTORY = new InjectionToken<ModelFactory>('INITIAL_MODEL_FACTORY', {
  providedIn: 'root',
  factory: (): ModelFactory => () => new THREE.Group()
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
  private readonly modelStorage = inject(ModelStorageService);
  private readonly modelBySession = new KeyedStore<number, THREE.Object3D>();

  constructor() {
    // Once a session actually closes, dispose its model's GPU resources
    // (geometry/material) before dropping the reference - otherwise every
    // closed session leaks VRAM forever. Also drops its ModelStorageService
    // snapshot - a closed session's data shouldn't come back if the same id
    // were ever somehow reused (it isn't - see SessionsService's own
    // nextId comment - but there's no reason to keep it around either).
    effect(() => {
      this.modelBySession.pruneTo(
        this.sessions.sessions().map(session => session.id),
        (model, sessionId) => {
          this.disposeModel(model);
          this.modelStorage.delete(sessionId);
        }
      );
    });
  }

  // Checks ModelStorageService FIRST, not just createInitialModel - a
  // session whose only WorldCanvasComponent view was ever destroyed and
  // recreated (toolbar-icon switch, WebGL context-loss recovery) still has
  // whatever the user last built, via commit() below, instead of silently
  // starting over from a blank model.
  getModel(sessionId: number): THREE.Object3D {
    return this.modelBySession.getOrCreate(sessionId, () => this.modelStorage.load(sessionId) ?? this.createInitialModel());
  }

  // The only write path - see WorldCanvasComponent's own callers (ngOnDestroy,
  // updateSession) for exactly when this needs to run: right before this
  // session's model might stop being represented by a live, in-scene
  // Object3D (a canvas destroy, or switching away to another session), so
  // whatever's actually there gets captured, not just whatever this service
  // was told about last.
  commit(sessionId: number, object: THREE.Object3D): void {
    this.modelBySession.set(sessionId, object);
    this.modelStorage.save(sessionId, object);
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