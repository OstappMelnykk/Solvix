import { Injectable, effect, inject } from '@angular/core';
import * as THREE from 'three';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { isWatertight } from '../geometry/watertight-check';
import { disposeObject3D } from '../geometry/dispose-object3d';
import { recenterAtOrigin } from '../geometry/recenter-object3d';
import { computeMeshStats } from '../geometry/mesh-stats';

export interface ImportedGeometry {
  // A pivot Group wrapping the loaded object, NOT the loaded object
  // itself - its local (0,0,0) is the object's own geometric center (see
  // `set()`), so rotating this pivot (ImportedReferenceRenderService) spins
  // the object in place instead of orbiting around an arbitrary
  // file-authored local origin.
  readonly object: THREE.Object3D;
  readonly fileName: string;
  readonly watertight: boolean;
  readonly meshCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  // Bounding-box size in the object's own (unscaled) coordinates, plus which
  // axis is longest - general geometric metadata about the import (e.g. a
  // future voxelization feature would use this to derive its cube density
  // from the longest axis, proportions preserved).
  readonly boundingSize: THREE.Vector3;
  readonly longestAxis: 0 | 1 | 2;
  readonly longestLength: number;
  // The actual min/max, AFTER `set()` has recentered `object` so its
  // footprint is centered on X/Z (e.g. min.x = -0.5, max.x = 0.5 for a
  // 1-unit-wide import) but it rests on the floor with min.y = 0, unlike
  // `object`'s own original, unrecentered local geometry.
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

    // Center `object`'s own local geometry on ITS OWN origin first (before
    // wrapping in `pivot` below) - this makes the pivot's local (0,0,0)
    // coincide with the object's true geometric center, so that later
    // rotating `pivot` (ImportedReferenceRenderService, user-driven via the
    // rotate gizmo) spins the object in place around its own center rather
    // than orbiting around wherever the source file happened to put its
    // local origin.
    object.updateMatrixWorld(true);
    const ownCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
    object.position.sub(ownCenter);
    object.updateMatrixWorld(true);

    const pivot = new THREE.Group();
    pivot.add(object);
    // Recenter the pivot so the bounding box is centered on X/Z and rests
    // on the floor (min.y = 0) - imported files can have their geometry
    // authored anywhere (off to one side, a corner at the origin, etc.),
    // but every downstream consumer (the display-scale reference,
    // dimension lines) needs a known, fixed position to work from rather
    // than wherever the source file happened to place it.
    recenterAtOrigin(pivot);

    const boundingBox = new THREE.Box3().setFromObject(pivot);
    const boundingSize = boundingBox.getSize(new THREE.Vector3());
    const longestAxis: 0 | 1 | 2 =
      boundingSize.x >= boundingSize.y && boundingSize.x >= boundingSize.z ? 0 : boundingSize.y >= boundingSize.z ? 1 : 2;
    const longestLength = [boundingSize.x, boundingSize.y, boundingSize.z][longestAxis];
    const stats = computeMeshStats(pivot);

    this.bySession.set(sessionId, {
      object: pivot,
      fileName,
      watertight: isWatertight(pivot),
      meshCount: stats.meshCount,
      triangleCount: stats.triangleCount,
      vertexCount: stats.vertexCount,
      boundingSize,
      longestAxis,
      longestLength,
      boundingBox
    });
  }
}