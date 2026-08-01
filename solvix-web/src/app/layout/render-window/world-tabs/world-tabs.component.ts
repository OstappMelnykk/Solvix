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

  // -1 when there's no active session - never matches a tab's index.
  readonly activeWorldIndex = computed(() => {
    const sessionId = this.sessions.activeSessionId();
    return sessionId === null ? -1 : this.activeWorld.activeWorldIndex(sessionId)();
  });

  selectWorld(index: number): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null) {
      return;
    }
    this.activeWorld.selectWorld(sessionId, index);
  }
}