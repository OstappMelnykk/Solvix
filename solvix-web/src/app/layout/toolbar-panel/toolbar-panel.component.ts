import { Component, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { WorkspaceViewService } from '../../state/workspace-view.service';
import { WORKSPACE_VIEWS } from '../workspace-views';

// Icons are inlined raw SVG in the template (Lucide "boxes"/"settings" path
// data), not the @lucide/angular package: its latest release ships
// templates compiled against a much newer Angular version than this app's
// (18.2) - the generated @for-loop track function references a compiler
// internal (`tmp_4_0`) that doesn't exist in this runtime, so every icon
// throws at render time. Static SVG has no such coupling.
@Component({
  selector: 'app-toolbar-panel',
  standalone: true,
  imports: [NgFor, NgIf],
  templateUrl: './toolbar-panel.component.html',
  styleUrl: './toolbar-panel.component.scss'
})
export class ToolbarPanelComponent {
  private readonly workspace = inject(WorkspaceViewService);
  readonly icons = WORKSPACE_VIEWS.map((_, i) => i);
  readonly activeView = this.workspace.activeView;

  selectView(index: number): void {
    this.workspace.selectView(index);
  }
}