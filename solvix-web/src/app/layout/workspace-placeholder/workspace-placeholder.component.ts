import { Component, inject } from '@angular/core';
import { WorkspaceViewService } from '../../state/workspace-view.service';

// Stand-in for any toolbar tool that doesn't have its own workspace
// component yet. Reads its own index straight from WorkspaceViewService
// instead of receiving it as an @Input - NgComponentOutlet only ever
// renders one view at a time, so there's no "which of several siblings am
// I" ambiguity to resolve (unlike WorldCanvasComponent's @Input worldIndex,
// which distinguishes 3 simultaneous instances of the same component).
@Component({
  selector: 'app-workspace-placeholder',
  standalone: true,
  imports: [],
  templateUrl: './workspace-placeholder.component.html',
  styleUrl: './workspace-placeholder.component.scss'
})
export class WorkspacePlaceholderComponent {
  private readonly workspace = inject(WorkspaceViewService);
  readonly index = this.workspace.activeView;
}