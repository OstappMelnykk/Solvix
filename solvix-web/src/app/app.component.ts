import { Component, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { SessionTabsComponent } from './layout/session-tabs/session-tabs.component';
import { SessionComponent } from './layout/session/session.component';
import { ToolbarPanelComponent } from './layout/toolbar-panel/toolbar-panel.component';
import { FooterComponent } from './layout/footer/footer.component';
import { SessionsService } from './state/sessions.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    NgFor,
    RouterOutlet,
    SessionTabsComponent,
    SessionComponent,
    ToolbarPanelComponent,
    FooterComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  readonly sessions = inject(SessionsService);

  title = 'solvix-web';
  appWidth = window.innerWidth;
  appHeight = window.innerHeight;
}