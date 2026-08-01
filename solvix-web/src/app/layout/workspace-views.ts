import { Type } from '@angular/core';
import { CadWorkspaceComponent } from './cad-workspace/cad-workspace.component';
import { WorkspacePlaceholderComponent } from './workspace-placeholder/workspace-placeholder.component';

// Every toolbar icon maps 1:1 to a component that renders the whole main
// body area for that tool - AppComponent hosts whichever one is active via
// NgComponentOutlet instead of growing an *ngIf/*ngSwitch branch per tool.
// ToolbarPanelComponent derives its icon count from this array's length, so
// the two can't silently drift apart.
//
// Lives here (layout/), not config/app-settings.ts: this array references
// component classes, and RenderWindowComponent (reached through
// CadWorkspaceComponent) already imports app-settings.ts for WORLDS_CONFIG
// - putting this here instead avoids a circular import between the two.
export const WORKSPACE_VIEWS: Type<unknown>[] = [
  CadWorkspaceComponent,
  WorkspacePlaceholderComponent,
  WorkspacePlaceholderComponent,
  WorkspacePlaceholderComponent,
  WorkspacePlaceholderComponent
];