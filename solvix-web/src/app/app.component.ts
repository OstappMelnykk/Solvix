import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SplitComponent, SplitAreaComponent } from 'angular-split';
import { SessionTabsComponent } from './layout/session-tabs/session-tabs.component';
import { ViewportComponent } from './layout/viewport/viewport.component';
import { ViewportToolbarComponent } from './layout/viewport-toolbar/viewport-toolbar.component';
import { StatusBarComponent } from './layout/status-bar/status-bar.component';
import { PropertiesPanelComponent } from './layout/properties-panel/properties-panel.component';
import { WorldsPanelComponent } from './layout/worlds-panel/worlds-panel.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    SplitComponent,
    SplitAreaComponent,
    SessionTabsComponent,
    ViewportComponent,
    ViewportToolbarComponent,
    StatusBarComponent,
    PropertiesPanelComponent,
    WorldsPanelComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'solvix-web';
  appWidth = window.innerWidth;
  appHeight = window.innerHeight;
  viewportInitialWidth = Math.round(window.screen.width * 0.8);
  propertiesMinWidth = Math.round(window.screen.width * 0.2);
  propertiesMaxWidth = Math.round(window.screen.width * 0.4);
}