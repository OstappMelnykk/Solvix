import { Component, computed, inject } from '@angular/core';
import { ActiveWorldService } from '../../state/active-world.service';
import { SessionsService } from '../../state/sessions.service';

// (sessionId, worldIndex) together identify which World's settings this
// panel shows - both are read directly from the currently active session,
// since there's only one shared settings panel for the whole app now. Both
// are null when no session is open - AppComponent hides this component
// entirely in that state, but the computeds stay null-safe regardless.
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
  readonly worldIndex = this.activeWorld.currentWorldIndex;
}