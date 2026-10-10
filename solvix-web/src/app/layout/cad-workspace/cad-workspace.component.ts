import { Component, computed, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import { SplitComponent, SplitAreaComponent, SplitGutterInteractionEvent } from 'angular-split';
import { RenderWindowComponent } from '../render-window/render-window.component';
import { SettingsPanelComponent } from '../settings-panel/settings-panel.component';
import { RenderSettingsSplitService } from '../../state/render-settings-split.service';
import { SessionsService } from '../../state/sessions.service';
import { ActiveWorldService } from '../../state/active-world.service';
import { QUALITY_WORLD_INDEX } from '../../config/app-settings';

// The CAD workspace tool (toolbar icon 0): render-window + settings-panel
// split. Its own component rather than inlined in AppComponent, so swapping
// it for another tool (see WORKSPACE_VIEWS/NgComponentOutlet in
// AppComponent) doesn't require AppComponent to know anything about what
// any given tool actually renders - a tool's content can be arbitrarily
// large without growing AppComponent's template.
@Component({
  selector: 'app-cad-workspace',
  standalone: true,
  imports: [NgIf, SplitComponent, SplitAreaComponent, RenderWindowComponent, SettingsPanelComponent],
  templateUrl: './cad-workspace.component.html',
  styleUrl: './cad-workspace.component.scss'
})
export class CadWorkspaceComponent {
  readonly split = inject(RenderSettingsSplitService);
  readonly sessions = inject(SessionsService);
  private readonly activeWorld = inject(ActiveWorldService);

  // The Quality World has no settings panel: its own wide panel sits next to the canvas (see RenderWindowComponent).
  readonly hidesSettings = computed(() => this.activeWorld.currentWorldIndex() === QUALITY_WORLD_INDEX);

  onDragEnd(event: SplitGutterInteractionEvent): void {
    const settingsWidth = event.sizes[1];
    if (typeof settingsWidth === 'number') {
      this.split.setSettingsWidth(settingsWidth);
    }
  }
}