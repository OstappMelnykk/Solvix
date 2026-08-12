import { Injectable, effect, inject } from '@angular/core';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';

export type ImportedReferenceMode = 'solid' | 'wireframe';

export interface ImportedReferenceStyle {
  readonly visible: boolean;
  readonly mode: ImportedReferenceMode;
  readonly color: number;
  readonly opacity: number;
  // Whether the draftsman-style axis dimension lines (geometry/dimension-lines.ts)
  // are shown alongside the reference - independent of `visible` above, so
  // the geometry can be hidden while its measured size stays on screen, or
  // vice versa.
  readonly dimensionsVisible: boolean;
  // Whether the green tick-mark ruler along the longest axis (geometry/ruler-preview.ts)
  // is shown - a separate concept from dimensionsVisible (different visual,
  // different purpose: ticks-per-density vs. exact measured length).
  readonly rulerVisible: boolean;
  // How far past the object's own surface the ruler sits, along that
  // surface's normal - see buildRulerPreview.
  readonly rulerDistance: number;
  // Whether the rotate gizmo (3 draggable ring arcs, world-canvas.component.ts)
  // is shown/interactive - independent of `visible`, so the user can hide
  // the rings (e.g. to inspect the geometry unobstructed) without losing
  // the reference itself.
  readonly rotateGizmoVisible: boolean;
}

const DEFAULT_STYLE: ImportedReferenceStyle = {
  visible: true,
  mode: 'solid',
  color: 0xffffff,
  opacity: 0.5,
  dimensionsVisible: true,
  rulerVisible: true,
  rulerDistance: 1,
  rotateGizmoVisible: true
};

// How the imported reference geometry (ImportedGeometryService) should be
// DRAWN, per session - separate from the geometry itself, which never
// changes just because the user wants to look at it differently. Purely a
// display preference: WorldCanvasComponent reads this to build the
// material, nothing about voxelization/import/watertightness depends on it.
@Injectable({ providedIn: 'root' })
export class ImportedReferenceDisplayService {
  private readonly sessions = inject(SessionsService);
  private readonly styleBySession = new KeyedStore<number, ImportedReferenceStyle>();

  constructor() {
    effect(() => {
      this.styleBySession.pruneTo(this.sessions.sessions().map(session => session.id));
    });
  }

  getStyle(sessionId: number): ImportedReferenceStyle {
    return this.styleBySession.get(sessionId) ?? DEFAULT_STYLE;
  }

  setVisible(sessionId: number, visible: boolean): void {
    this.update(sessionId, { visible });
  }

  setMode(sessionId: number, mode: ImportedReferenceMode): void {
    this.update(sessionId, { mode });
  }

  setColor(sessionId: number, color: number): void {
    this.update(sessionId, { color });
  }

  setOpacity(sessionId: number, opacity: number): void {
    this.update(sessionId, { opacity: Math.min(1, Math.max(0, opacity)) });
  }

  setDimensionsVisible(sessionId: number, visible: boolean): void {
    this.update(sessionId, { dimensionsVisible: visible });
  }

  setRulerVisible(sessionId: number, visible: boolean): void {
    this.update(sessionId, { rulerVisible: visible });
  }

  setRulerDistance(sessionId: number, distance: number): void {
    this.update(sessionId, { rulerDistance: Math.max(0, distance) });
  }

  setRotateGizmoVisible(sessionId: number, visible: boolean): void {
    this.update(sessionId, { rotateGizmoVisible: visible });
  }

  private update(sessionId: number, patch: Partial<ImportedReferenceStyle>): void {
    this.styleBySession.set(sessionId, { ...this.getStyle(sessionId), ...patch });
  }
}