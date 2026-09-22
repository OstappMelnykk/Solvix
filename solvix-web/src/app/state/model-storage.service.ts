import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { readJson, removeKey, writeJson } from './local-storage-json';

const STORAGE_KEY_PREFIX = 'solvix:model:';

// Stand-in for a real backend persistence call - Solvix.Api/CadWorkspaceApiService
// is scaffolded (HttpClient wired up) but has zero endpoints yet (see
// docs/FRONTEND_ARCHITECTURE.md). This holds exactly what a real save would send:
// a session's model, generically serialized via three.js's own Object3D.toJSON()/
// ObjectLoader format - NOT a hand-rolled schema for specific shape types (box/
// sphere/tetrahedron/...), since what a user actually builds is arbitrary and
// open-ended, and toJSON() already captures whatever geometry/material/hierarchy
// is really there, whatever that turns out to be.
//
// Backed by localStorage (see local-storage-json.ts), not a plain in-memory
// Map - a live THREE.Object3D already survives a session switch or a
// WorldCanvasComponent destroy/recreate (toolbar-icon switch, WebGL
// context-loss recovery) on its own, for as long as this page stays loaded;
// the whole point of THIS layer is surviving a genuine page reload too,
// which an in-memory Map (or the live object itself) never would. Not a
// KeyedStore with its own pruneTo effect - SharedModelService already runs
// that effect and is this service's only caller; duplicating the same
// reactive cleanup here would just be a second place for the two to drift
// out of sync.
//
// The seam that becomes a real server round-trip later with no shape
// change - swap save()/load()'s bodies for HttpClient calls to
// CadWorkspaceApiService, keep every caller exactly as-is.
@Injectable({ providedIn: 'root' })
export class ModelStorageService {
  save(sessionId: number, model: THREE.Object3D): void {
    writeJson(STORAGE_KEY_PREFIX + sessionId, model.toJSON());
  }

  // null when nothing was ever saved for this session (brand-new session) -
  // callers fall back to their own default in that case, same as
  // KeyedStore.getOrCreate's own factory pattern elsewhere in state/.
  load(sessionId: number): THREE.Object3D | null {
    const json = readJson<object>(STORAGE_KEY_PREFIX + sessionId);
    if (!json) {
      return null;
    }
    return new THREE.ObjectLoader().parse(json);
  }

  delete(sessionId: number): void {
    removeKey(STORAGE_KEY_PREFIX + sessionId);
  }
}
