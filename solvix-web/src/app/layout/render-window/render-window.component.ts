import { Component, computed, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { WORLDS_CONFIG } from '../../config/app-settings';
import { ActiveWorldService } from '../../state/active-world.service';
import { WorldRepresentation, WorldRepresentationService } from '../../state/world-representation.service';
import { SessionsService } from '../../state/sessions.service';
import { WorldTabsComponent } from './world-tabs/world-tabs.component';
import { WorldCanvasComponent } from './world-canvas/world-canvas.component';

// App-level, single instance - not one per session. Its 3 WorldCanvasComponent
// children are the only 3 WebGL contexts the app ever creates; switching
// sessions just changes which session's model they draw (see
// WorldRepresentationService), not which canvases exist.
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
  readonly worlds = WORLDS_CONFIG;

  readonly activeWorldIndex = computed(() => this.activeWorld.activeWorldIndex(this.sessions.activeSessionId())());

  getRepresentation(worldIndex: number): WorldRepresentation {
    return this.representations.getRepresentation(this.sessions.activeSessionId(), worldIndex);
  }
}