import { Component, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { WORLDS_CONFIG } from '../../../config/app-settings';
import { ActiveWorldService } from '../../../state/active-world.service';

@Component({
  selector: 'app-world-tabs',
  standalone: true,
  imports: [NgFor],
  templateUrl: './world-tabs.component.html',
  styleUrl: './world-tabs.component.scss'
})
export class WorldTabsComponent {
  private readonly activeWorld = inject(ActiveWorldService);
  readonly worlds = WORLDS_CONFIG;

  // null when there's no active session - never matches a tab's index.
  readonly activeWorldIndex = this.activeWorld.currentWorldIndex;

  selectWorld(index: number): void {
    this.activeWorld.selectCurrentWorld(index);
  }
}