import { Component, Input, inject } from '@angular/core';
import { SplitComponent, SplitAreaComponent, SplitGutterInteractionEvent } from 'angular-split';
import { RenderWindowComponent } from '../render-window/render-window.component';
import { SettingsPanelComponent } from '../settings-panel/settings-panel.component';
import { ActiveWorldService } from '../../state/active-world.service';
import { SharedModelService } from '../../state/shared-model.service';
import { WorldRepresentationService } from '../../state/world-representation.service';
import { PanelLayoutService } from '../../state/panel-layout.service';

// One Session = its own 3 Worlds + the one shared model they work on, plus
// the settings panel for whichever World is open. Providing the state
// services here, at the component level, gives every <app-session> instance
// its own private copy of them - so two sessions never see each other's
// active World, model, or representations. This is the actual isolation
// boundary; nothing about it is enforced by config.
//
// The settings panel lives inside this same scope (not as an AppComponent
// sibling) specifically so it can inject this session's ActiveWorldService
// and always show the currently open World's settings.
//
// Panel widths are NOT session-scoped (PanelLayoutService is root-provided)
// - every session's split reads/writes the same shared sizes, so the layout
// stays consistent when switching sessions.
@Component({
  selector: 'app-session',
  standalone: true,
  imports: [SplitComponent, SplitAreaComponent, RenderWindowComponent, SettingsPanelComponent],
  providers: [ActiveWorldService, SharedModelService, WorldRepresentationService],
  templateUrl: './session.component.html',
  styleUrl: './session.component.scss'
})
export class SessionComponent {
  @Input({ required: true }) sessionId!: number;

  readonly layout = inject(PanelLayoutService);

  onDragEnd(event: SplitGutterInteractionEvent): void {
    const [renderWindowWidth, settingsWidth] = event.sizes as number[];
    this.layout.setSizes(renderWindowWidth, settingsWidth);
  }
}