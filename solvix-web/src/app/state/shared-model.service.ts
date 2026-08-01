import { Injectable } from '@angular/core';
import * as THREE from 'three';

// The one model every World represents for a given session. `THREE.Object3D`
// is deliberately the most general Three.js "thing that goes into a scene"
// type - not BufferGeometry, since a real model will eventually be a whole
// group of hexahedra (their own geometry/material/position each), not a
// single shape with one shared material. `createInitialModel` is a
// placeholder, swap it to load a real per-session dataset later.
//
// Root-scoped and keyed by sessionId: there are only 3 WorldCanvasComponent
// instances for the whole app (one per World, shared across sessions), so
// each session's model has to be stored here rather than in a per-session
// component scope - switching sessions swaps which model those 3 shared
// canvases draw, without recreating any WebGL context.
@Injectable({ providedIn: 'root' })
export class SharedModelService {
  private readonly modelBySession = new Map<number, THREE.Object3D>();

  private readonly createInitialModel = () =>
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3574f0 }));

  getModel(sessionId: number): THREE.Object3D {
    let model = this.modelBySession.get(sessionId);
    if (!model) {
      model = this.createInitialModel();
      this.modelBySession.set(sessionId, model);
    }
    return model;
  }
}