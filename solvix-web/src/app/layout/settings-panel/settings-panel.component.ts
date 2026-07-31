import { Component, Input, inject } from '@angular/core';
import { ActiveWorldService } from '../../state/active-world.service';

// Lives inside SessionComponent's DI scope, so ActiveWorldService here is
// always that session's own instance. Combined with sessionId (passed down
// explicitly, since a component can't know its own session from context),
// (sessionId, activeWorld.activeWorldIndex()) uniquely identifies which
// World's settings this panel is currently showing.
@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [],
  templateUrl: './settings-panel.component.html',
  styleUrl: './settings-panel.component.scss'
})
export class SettingsPanelComponent {
  @Input({ required: true }) sessionId!: number;

  readonly activeWorld = inject(ActiveWorldService);
}