import { Component, computed, inject } from '@angular/core';
import { ActiveWorldService } from '../../state/active-world.service';
import { SessionsService } from '../../state/sessions.service';

// (sessionId, worldIndex) together identify which World's settings this
// panel shows - both are read directly from the currently active session,
// since there's only one shared settings panel for the whole app now.
@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [],
  templateUrl: './settings-panel.component.html',
  styleUrl: './settings-panel.component.scss'
})
export class SettingsPanelComponent {
  private readonly sessions = inject(SessionsService);
  private readonly activeWorld = inject(ActiveWorldService);

  readonly sessionId = computed(() => this.sessions.activeSessionId());
  readonly worldIndex = computed(() => this.activeWorld.activeWorldIndex(this.sessionId())());
}