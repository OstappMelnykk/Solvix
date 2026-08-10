import { Component, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { IDEAL_WORLD_INDEX, WORLDS_CONFIG } from '../../config/app-settings';
import { ActiveWorldService } from '../../state/active-world.service';
import { WorldRepresentation, WorldRepresentationService } from '../../state/world-representation.service';
import { SessionsService } from '../../state/sessions.service';
import { ImportedGeometryService } from '../../state/imported-geometry.service';
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
  readonly worlds = WORLDS_CONFIG;

  // null when there's no active session - never matches a real worldIndex,
  // so every WorldCanvasComponent ends up [hidden] and inactive, same as if
  // a World were simply never selected.
  readonly activeWorldIndex = this.activeWorld.currentWorldIndex;

  getRepresentation(worldIndex: number): WorldRepresentation | null {
    const sessionId = this.sessions.activeSessionId();
    return sessionId === null ? null : this.representations.getRepresentation(sessionId, worldIndex);
  }

  // Ideal-World-only (see IDEAL_WORLD_INDEX) - the raw imported object
  // (ImportedGeometryService), shown as a visual guide only, never part of
  // `representation`.
  getImportedReference(worldIndex: number): THREE.Object3D | null {
    if (worldIndex !== IDEAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    return sessionId === null ? null : (this.importedGeometry.get(sessionId)?.object ?? null);
  }
}