import { Injectable } from '@angular/core';
import * as THREE from 'three';

// The one model every World in a session works on. What this model
// actually is (its real shape/type) is undefined until the backend data
// contract exists. A plain BufferGeometry is used here only as a temporary
// stand-in so the frontend has something to render meanwhile.
//
// Scoped per-session - see SessionComponent's `providers`. Each session
// gets its own instance, so its model is never shared with another session.
@Injectable()
export class SharedModelService {
  private readonly model = new THREE.BoxGeometry(1, 1, 1);

  getModel(): THREE.BufferGeometry {
    return this.model;
  }
}