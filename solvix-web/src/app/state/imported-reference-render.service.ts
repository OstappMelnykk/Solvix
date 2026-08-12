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

// Owns everything about how the imported reference is actually PLACED and
// DRAWN in the 3D view, per session - scale (see "density" below), user-
// driven rotation (the rotate gizmo, WorldCanvasComponent), and the
// dimension-lines/ruler overlays derived from both. ImportedGeometryService's
// raw object is never mutated - this only ever builds fresh CLONEs of it
// (scaled/rotated/recentered), cached here so consumers get a STABLE object
// identity between rebuilds (WorldCanvasComponent only re-clones into its
// own scene when that identity changes - see getScaledReference below).
//
// "Density": the user picks how many world units the import's longest
// bounding-box axis should measure, independent of the file's real-world
// size (which can be anything: mm, inches, an arbitrary CAD unit,
// especially for .stl - see geometry/loaders/stl-file-loader.ts).
// Proportions are always preserved.
@Injectable({ providedIn: 'root' })
export class ImportedReferenceRenderService {
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
  // User-driven rotation of the reference (rotate gizmo, WorldCanvasComponent) -
  // applied around the pivot's local origin, which ImportedGeometryService
  // arranges to be the object's own geometric center. Absent = identity
  // (no rotation), the common case.
  private readonly rotationBySession = new KeyedStore<number, THREE.Quaternion>();

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
      this.rotationBySession.pruneTo(ids);
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

  // User-driven rotation (rotate gizmo) applied around the reference's own
  // geometric center - identity (no rotation) when nothing's been set yet.
  getRotation(sessionId: number): THREE.Quaternion {
    return this.rotationBySession.get(sessionId) ?? new THREE.Quaternion();
  }

  // Called by WorldCanvasComponent once a rotate-gizmo drag ends, so a
  // later rebuild (density change, new import, etc.) reconstructs the
  // clone at the SAME orientation the user left it at, instead of
  // silently snapping back to identity.
  setRotation(sessionId: number, rotation: THREE.Quaternion): void {
    this.rotationBySession.set(sessionId, rotation.clone());
    this.refreshScaledReference(sessionId);
  }

  // Back to unrotated - called when a new file replaces the current
  // import (settings-panel.component.ts), since a fresh import has no
  // business inheriting the previous file's orientation.
  resetRotation(sessionId: number): void {
    this.rotationBySession.delete(sessionId);
  }

  // Rebuilds the cached scaled clone (and its matching dimension lines and
  // ruler) from the CURRENT import + density + rotation. Call after a new
  // import lands (nothing to scale before that) and whenever density
  // changes (setDensity already does this).
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
    // Rotation is applied around the pivot's own local origin - which
    // ImportedGeometryService arranges to be the object's geometric
    // center - BEFORE recentering, so recenterAtOrigin grounds/centers the
    // POST-rotation world bbox (a rotated non-cubical object has different
    // world extents than its unrotated self).
    clone.quaternion.copy(this.getRotation(sessionId));
    recenterAtOrigin(clone);
    this.scaledReferenceBySession.set(sessionId, clone);

    // Built in the same local, pivot-centered frame as `clone` itself (see
    // dimension-lines.ts/ruler-preview.ts) - copying clone's own
    // position+quaternion onto them afterward is what keeps them rigidly
    // attached to the object through rotation, rather than staying
    // axis-aligned to world space.
    const localBox = this.getLocalBox(info, scale);
    const dimensionLines = buildDimensionLines(localBox);
    dimensionLines.position.copy(clone.position);
    dimensionLines.quaternion.copy(clone.quaternion);
    this.dimensionLinesBySession.set(sessionId, dimensionLines);

    this.refreshRuler(sessionId);
  }

  // Rebuilds ONLY the cached ruler, from the CURRENT import + density +
  // rotation + ImportedReferenceDisplayService's rulerDistance - call
  // whenever the distance changes on its own (density/rotation changes
  // already go through refreshScaledReference, which calls this too).
  refreshRuler(sessionId: number): void {
    const info = this.importedGeometry.get(sessionId);
    const scale = this.getScale(sessionId);
    const clone = this.scaledReferenceBySession.get(sessionId);
    if (!info || scale === null || !clone) {
      this.disposeRuler(sessionId);
      return;
    }
    const localBox = this.getLocalBox(info, scale);
    const distance = this.display.getStyle(sessionId).rulerDistance;
    this.disposeRuler(sessionId);
    const ruler = buildRulerPreview(localBox, info.longestAxis, this.getDensity(sessionId), distance);
    ruler.position.copy(clone.position);
    ruler.quaternion.copy(clone.quaternion);
    this.rulerBySession.set(sessionId, ruler);
  }

  // The reference's own bounding box in its LOCAL, pivot-centered frame -
  // symmetric about the origin on all 3 axes (unlike `info.boundingBox`,
  // which is the GROUNDED world box at scale 1) - see ImportedGeometryService
  // for why the pivot's local origin sits at the object's geometric center.
  private getLocalBox(info: { boundingSize: THREE.Vector3 }, scale: number): THREE.Box3 {
    const half = info.boundingSize.clone().multiplyScalar(scale * 0.5);
    return new THREE.Box3(half.clone().negate(), half);
  }

  private disposeRuler(sessionId: number): void {
    const previous = this.rulerBySession.get(sessionId);
    if (previous) {
      disposeRulerPreview(previous);
      this.rulerBySession.delete(sessionId);
    }
  }
}