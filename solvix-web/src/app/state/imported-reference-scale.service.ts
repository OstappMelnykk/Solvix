import { Injectable, effect, inject } from '@angular/core';
import * as THREE from 'three';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { ImportedGeometryService } from './imported-geometry.service';
import { ImportedReferenceDisplayService } from './imported-reference-display.service';
import { recenterAtOrigin } from '../geometry/recenter-object3d';
import { buildDimensionLines, disposeDimensionLines } from '../geometry/dimension-lines';
import { buildRulerPreview, disposeRulerPreview } from '../geometry/ruler-preview';

const DEFAULT_DENSITY = 8;
const MIN_DENSITY = 1;
const MAX_DENSITY = 90;

// How big the imported reference should APPEAR in the 3D view, per
// session - independent of the file's real-world size (which can be
// anything: mm, inches, an arbitrary CAD unit, especially for .stl - see
// geometry/loaders/stl-file-loader.ts). The user picks how many world
// units the import's longest bounding-box axis should measure
// ("density"), proportions preserved; ImportedGeometryService's raw object
// is never mutated - this only ever scales a CLONE of it, cached here.
@Injectable({ providedIn: 'root' })
export class ImportedReferenceScaleService {
  private readonly sessions = inject(SessionsService);
  private readonly importedGeometry = inject(ImportedGeometryService);
  private readonly display = inject(ImportedReferenceDisplayService);
  private readonly densityBySession = new KeyedStore<number, number>();
  // The scaled clone actually shown in the 3D view - built ONCE per
  // density/import change (refreshScaledReference), never per-call.
  // getScaledReference() just reads whatever's cached here:
  // WorldCanvasComponent only rebuilds its own scene clone when the OBJECT
  // IDENTITY it's handed changes, so returning a fresh .clone() on every
  // call would fail that identity check every animation frame and thrash.
  private readonly scaledReferenceBySession = new KeyedStore<number, THREE.Object3D>();
  // Draftsman-style dimension lines matching the current scaled reference -
  // unlike the reference clone above, these OWN their geometry/materials
  // (a fresh BufferGeometry + canvas-texture labels, nothing shared with
  // ImportedGeometryService), so they DO need disposing on prune.
  private readonly dimensionLinesBySession = new KeyedStore<number, THREE.Object3D>();
  // Green tick-mark ruler along the longest axis (geometry/ruler-preview.ts)
  // - owns its own geometry/materials same as dimensionLinesBySession, so
  // also needs disposing on prune/rebuild.
  private readonly rulerBySession = new KeyedStore<number, THREE.Object3D>();

  constructor() {
    effect(() => {
      const ids = this.sessions.sessions().map(session => session.id);
      this.densityBySession.pruneTo(ids);
      // Entries share geometry/material with ImportedGeometryService's raw
      // object (plain .clone(), no override at this layer) - that service
      // disposes the shared GPU resources when the session closes, so
      // nothing to dispose here, just drop the refs.
      this.scaledReferenceBySession.pruneTo(ids);
      this.dimensionLinesBySession.pruneTo(ids, lines => disposeDimensionLines(lines));
      this.rulerBySession.pruneTo(ids, ruler => disposeRulerPreview(ruler));
    });
  }

  getDensity(sessionId: number): number {
    return this.densityBySession.get(sessionId) ?? DEFAULT_DENSITY;
  }

  setDensity(sessionId: number, density: number): void {
    const clamped = Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, Math.round(density)));
    this.densityBySession.set(sessionId, clamped);
    this.refreshScaledReference(sessionId);
  }

  // Uniform factor applied to the whole imported object (proportions
  // preserved) so its longest bounding-box axis becomes exactly `density`
  // world units - null if nothing is imported, or the import is
  // degenerate (zero-size).
  getScale(sessionId: number): number | null {
    const info = this.importedGeometry.get(sessionId);
    if (!info || info.longestLength <= 0) {
      return null;
    }
    return this.getDensity(sessionId) / info.longestLength;
  }

  // The imported geometry, scaled so its longest axis measures `density`
  // world units - this, not the raw import, is what RenderWindowComponent
  // shows. null until refreshScaledReference() has run at least once for
  // this session (call right after a successful import).
  getScaledReference(sessionId: number): THREE.Object3D | null {
    return this.scaledReferenceBySession.get(sessionId) ?? null;
  }

  // Same identity-cache reasoning as getScaledReference - the axis
  // dimension lines matching whatever's currently shown.
  getDimensionLines(sessionId: number): THREE.Object3D | null {
    return this.dimensionLinesBySession.get(sessionId) ?? null;
  }

  // Same identity-cache reasoning as getScaledReference - the green
  // tick-mark ruler matching whatever's currently shown.
  getRuler(sessionId: number): THREE.Object3D | null {
    return this.rulerBySession.get(sessionId) ?? null;
  }

  // Rebuilds the cached scaled clone (and its matching dimension lines and
  // ruler) from the CURRENT import + density. Call after a new import
  // lands (nothing to scale before that) and whenever density changes
  // (setDensity already does this).
  refreshScaledReference(sessionId: number): void {
    const info = this.importedGeometry.get(sessionId);
    const scale = this.getScale(sessionId);

    const previousLines = this.dimensionLinesBySession.get(sessionId);
    if (previousLines) {
      disposeDimensionLines(previousLines);
      this.dimensionLinesBySession.delete(sessionId);
    }

    if (!info || scale === null) {
      this.scaledReferenceBySession.delete(sessionId);
      this.disposeRuler(sessionId);
      return;
    }
    const clone = info.object.clone();
    clone.scale.setScalar(scale);
    // info.object is already centered at scale 1 (ImportedGeometryService),
    // but scaling around its own local origin drifts the world-space
    // center away from 0 unless scale is exactly 1 - reapply centering
    // post-scale rather than deriving the position offset by hand.
    recenterAtOrigin(clone);
    this.scaledReferenceBySession.set(sessionId, clone);
    this.dimensionLinesBySession.set(sessionId, buildDimensionLines(info.boundingBox, scale));
    this.refreshRuler(sessionId);
  }

  // Rebuilds ONLY the cached ruler, from the CURRENT import + density +
  // ImportedReferenceDisplayService's rulerDistance - call whenever the
  // distance changes on its own (density changes already go through
  // refreshScaledReference, which calls this too).
  refreshRuler(sessionId: number): void {
    const info = this.importedGeometry.get(sessionId);
    const scale = this.getScale(sessionId);
    if (!info || scale === null) {
      this.disposeRuler(sessionId);
      return;
    }
    const scaledBox = new THREE.Box3(info.boundingBox.min.clone().multiplyScalar(scale), info.boundingBox.max.clone().multiplyScalar(scale));
    const distance = this.display.getStyle(sessionId).rulerDistance;
    this.disposeRuler(sessionId);
    this.rulerBySession.set(sessionId, buildRulerPreview(scaledBox, info.longestAxis, this.getDensity(sessionId), distance));
  }

  private disposeRuler(sessionId: number): void {
    const previous = this.rulerBySession.get(sessionId);
    if (previous) {
      disposeRulerPreview(previous);
      this.rulerBySession.delete(sessionId);
    }
  }
}