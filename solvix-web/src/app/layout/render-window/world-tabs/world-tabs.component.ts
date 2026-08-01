import { Component, computed, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { WORLDS_CONFIG } from '../../../config/app-settings';
import { ActiveWorldService } from '../../../state/active-world.service';
import { SessionsService } from '../../../state/sessions.service';

@Component({
  selector: 'app-world-tabs',
  standalone: true,
  imports: [NgFor],
  templateUrl: './world-tabs.component.html',
  styleUrl: './world-tabs.component.scss'
})
export class WorldTabsComponent {
  private readonly sessions = inject(SessionsService);
  private readonly activeWorld = inject(ActiveWorldService);
  readonly worlds = WORLDS_CONFIG;

  readonly activeWorldIndex = computed(() => this.activeWorld.activeWorldIndex(this.sessions.activeSessionId())());

  selectWorld(index: number): void {
    this.activeWorld.selectWorld(this.sessions.activeSessionId(), index);
  }
}