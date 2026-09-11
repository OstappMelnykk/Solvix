import { Component, computed, inject } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { SessionTabsComponent } from './layout/session-tabs/session-tabs.component';
import { ToolbarPanelComponent } from './layout/toolbar-panel/toolbar-panel.component';
import { FooterComponent } from './layout/footer/footer.component';
import { SixViewOverlayComponent } from './layout/six-view-overlay/six-view-overlay.component';
import { WorkspaceViewService } from './state/workspace-view.service';
import { WORKSPACE_VIEWS } from './layout/workspace-views';

// A thin host: doesn't know what any given toolbar tool actually renders,
// just which component slot is active (WorkspaceViewService) and which
// component that slot maps to (WORKSPACE_VIEWS) - NgComponentOutlet swaps
// the whole main body area for that component. Adding a 6th tool means
// adding one entry to WORKSPACE_VIEWS, not another branch here.
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgComponentOutlet, RouterOutlet, SessionTabsComponent, ToolbarPanelComponent, FooterComponent, SixViewOverlayComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  private readonly workspace = inject(WorkspaceViewService);

  title = 'solvix-web';
  readonly activeComponent = computed(() => WORKSPACE_VIEWS[this.workspace.activeView()]);
}