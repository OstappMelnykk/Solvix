import { Component, OnDestroy, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import * as THREE from 'three';
import { WORLDS_CONFIG } from '../../config/worlds.config';
import { ActiveWorldService } from '../../state/active-world.service';
import { WorldRepresentationService } from '../../state/world-representation.service';
import { WorldTabsComponent } from './world-tabs/world-tabs.component';
import { WorldCanvasComponent } from './world-canvas/world-canvas.component';

@Component({
  selector: 'app-render-window',
  standalone: true,
  imports: [NgFor, WorldTabsComponent, WorldCanvasComponent],
  templateUrl: './render-window.component.html',
  styleUrl: './render-window.component.scss'
})
export class RenderWindowComponent implements OnDestroy {
  readonly state = inject(ActiveWorldService);
  readonly representations = inject(WorldRepresentationService);
  readonly worlds = WORLDS_CONFIG;

  // Material stays shared - it's a display concern (color/style), not part
  // of the shared-model question.
  readonly material = new THREE.MeshStandardMaterial({ color: 0x3574f0 });

  ngOnDestroy(): void {
    this.material.dispose();
  }
}