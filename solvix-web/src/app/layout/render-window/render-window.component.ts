import { Component, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { IDEAL_WORLD_INDEX, WORLDS_CONFIG } from '../../config/app-settings';
import { ActiveWorldService } from '../../state/active-world.service';
import { WorldRepresentation, WorldRepresentationService } from '../../state/world-representation.service';
import { SessionsService } from '../../state/sessions.service';
import { ImportedGeometryService } from '../../state/imported-geometry.service';
import { ImportedReferenceDisplayService, ImportedReferenceStyle } from '../../state/imported-reference-display.service';
import { ImportedReferenceRenderService } from '../../state/imported-reference-render.service';
import { WorldTabsComponent } from './world-tabs/world-tabs.component';
import { WorldCanvasComponent } from './world-canvas/world-canvas.component';
import * as THREE from 'three';

// App-level, single instance - not one per session. Its 3 WorldCanvasComponent
// children are the only 3 WebGL contexts the app ever creates; switching
// sessions just changes which session's model they draw (see
// WorldRepresentationService), not which canvases exist. Stays mounted (see
// AppComponent's [hidden], not *ngIf) even when there are zero sessions
// open - the 3 canvases just show nothing until a session exists again.
@Component({
  selector: 'app-render-window',
  standalone: true,
  imports: [NgFor, WorldTabsComponent, WorldCanvasComponent],
  templateUrl: './render-window.component.html',
  styleUrl: './render-window.component.scss'
})
export class RenderWindowComponent {
  readonly sessions = inject(SessionsService);
  private readonly activeWorld = inject(ActiveWorldService);
  private readonly representations = inject(WorldRepresentationService);
  private readonly importedGeometry = inject(ImportedGeometryService);
  private readonly importedReferenceDisplay = inject(ImportedReferenceDisplayService);
  private readonly importedReferenceRender = inject(ImportedReferenceRenderService);
  readonly worlds = WORLDS_CONFIG;

  // null when there's no active session - never matches a real worldIndex,
  // so every WorldCanvasComponent ends up [hidden] and inactive, same as if
  // a World were simply never selected.
  readonly activeWorldIndex = this.activeWorld.currentWorldIndex;

  getRepresentation(worldIndex: number): WorldRepresentation | null {
    const sessionId = this.sessions.activeSessionId();
    return sessionId === null ? null : this.representations.getRepresentation(sessionId, worldIndex);
  }

  // Ideal-World-only (see IDEAL_WORLD_INDEX) - shown as a visual guide
  // only, never part of `representation`. Prefers ImportedReferenceRenderService's
  // scaled clone (what "Розмір" in the settings panel actually controls) so
  // the user sees the SAME thing that any future size-dependent operation
  // would use, not the raw unscaled import - falls back to the raw object
  // only for the degenerate case where scaling isn't defined yet (e.g.
  // right after import, before refreshScaledReference has run). null when
  // hidden (ImportedReferenceDisplayService), same as if nothing were
  // imported at all - WorldCanvasComponent doesn't need to know visibility
  // is a separate concept from "is there anything to show".
  getImportedReference(worldIndex: number): THREE.Object3D | null {
    if (worldIndex !== IDEAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null || !this.importedReferenceDisplay.getStyle(sessionId).visible) {
      return null;
    }
    return this.importedReferenceRender.getScaledReference(sessionId) ?? this.importedGeometry.get(sessionId)?.object ?? null;
  }

  // Ideal-World-only, same gating as getImportedReference - how to DRAW
  // whatever that returns. WorldCanvasComponent only reads this when
  // importedReference is itself non-null, so null here (no active
  // session) is never actually used to build anything.
  getImportedReferenceStyle(worldIndex: number): ImportedReferenceStyle | null {
    if (worldIndex !== IDEAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    return sessionId === null ? null : this.importedReferenceDisplay.getStyle(sessionId);
  }

  // Ideal-World-only, independent of getImportedReference's own visibility
  // (ImportedReferenceStyle.dimensionsVisible) - the measured size can stay
  // on screen even while the geometry itself is hidden, or vice versa.
  getDimensionLines(worldIndex: number): THREE.Object3D | null {
    if (worldIndex !== IDEAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null || !this.importedReferenceDisplay.getStyle(sessionId).dimensionsVisible) {
      return null;
    }
    return this.importedReferenceRender.getDimensionLines(sessionId);
  }

  // Ideal-World-only, independent of getImportedReference's own visibility
  // (ImportedReferenceStyle.rulerVisible) - same reasoning as getDimensionLines.
  getRuler(worldIndex: number): THREE.Object3D | null {
    if (worldIndex !== IDEAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null || !this.importedReferenceDisplay.getStyle(sessionId).rulerVisible) {
      return null;
    }
    return this.importedReferenceRender.getRuler(sessionId);
  }
}