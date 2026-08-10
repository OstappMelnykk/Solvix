import { Injectable, effect, inject } from '@angular/core';
import * as THREE from 'three';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { isWatertight } from '../geometry/watertight-check';
import { disposeObject3D } from '../geometry/dispose-object3d';

export interface ImportedGeometry {
  readonly object: THREE.Object3D;
  readonly fileName: string;
  readonly watertight: boolean;
  // Bounding-box size in the object's own (unscaled) coordinates, plus which
  // axis is longest - general geometric metadata about the import (e.g. a
  // future voxelization feature would use this to derive its cube density
  // from the longest axis, proportions preserved).
  readonly boundingSize: THREE.Vector3;
  readonly longestAxis: 0 | 1 | 2;
  readonly longestLength: number;
  // The actual min/max, NOT assumed centered at the origin - an imported
  // mesh's local origin can be anywhere (a corner, off to one side, etc.),
  // so anything that needs to sit exactly where the object is has to read
  // this, not just `boundingSize`.
  readonly boundingBox: THREE.Box3;
}

// A user-imported reference mesh (see geometry/model-import.service.ts),
// kept per session - deliberately NOT the same thing as SharedModelService's
// model. This is reference geometry shown alongside the real session model,
// not something that gets edited or refined itself. Same KeyedStore-per-
// session, dispose-on-close shape as SharedModelService.
@Injectable({ providedIn: 'root' })
export class ImportedGeometryService {
  private readonly sessions = inject(SessionsService);
  private readonly bySession = new KeyedStore<number, ImportedGeometry>();

  constructor() {
    effect(() => {
      this.bySession.pruneTo(
        this.sessions.sessions().map(session => session.id),
        entry => disposeObject3D(entry.object)
      );
    });
  }

  get(sessionId: number): ImportedGeometry | null {
    return this.bySession.get(sessionId) ?? null;
  }

  // Replaces whatever was previously imported for this session, if
  // anything - freeing its GPU resources first (re-importing a new file is
  // the common case, not a one-shot import per session).
  set(sessionId: number, object: THREE.Object3D, fileName: string): void {
    const existing = this.bySession.get(sessionId);
    if (existing) {
      disposeObject3D(existing.object);
    }
    const boundingBox = new THREE.Box3().setFromObject(object);
    const boundingSize = boundingBox.getSize(new THREE.Vector3());
    const longestAxis: 0 | 1 | 2 =
      boundingSize.x >= boundingSize.y && boundingSize.x >= boundingSize.z ? 0 : boundingSize.y >= boundingSize.z ? 1 : 2;
    const longestLength = [boundingSize.x, boundingSize.y, boundingSize.z][longestAxis];

    this.bySession.set(sessionId, {
      object,
      fileName,
      watertight: isWatertight(object),
      boundingSize,
      longestAxis,
      longestLength,
      boundingBox
    });
  }
}