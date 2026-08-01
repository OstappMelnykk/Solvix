import { Component, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { SplitComponent, SplitAreaComponent, SplitGutterInteractionEvent } from 'angular-split';
import { SessionTabsComponent } from './layout/session-tabs/session-tabs.component';
import { RenderWindowComponent } from './layout/render-window/render-window.component';
import { SettingsPanelComponent } from './layout/settings-panel/settings-panel.component';
import { ToolbarPanelComponent } from './layout/toolbar-panel/toolbar-panel.component';
import { FooterComponent } from './layout/footer/footer.component';
import { RenderSettingsSplitService } from './state/render-settings-split.service';
import { SessionsService } from './state/sessions.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    NgIf,
    RouterOutlet,
    SplitComponent,
    SplitAreaComponent,
    SessionTabsComponent,
    RenderWindowComponent,
    SettingsPanelComponent,
    ToolbarPanelComponent,
    FooterComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  readonly split = inject(RenderSettingsSplitService);
  readonly sessions = inject(SessionsService);

  title = 'solvix-web';
  appWidth = window.innerWidth;
  appHeight = window.innerHeight;

  onDragEnd(event: SplitGutterInteractionEvent): void {
    const settingsWidth = event.sizes[1];
    if (typeof settingsWidth === 'number') {
      this.split.setSettingsWidth(settingsWidth);
    }
  }
}