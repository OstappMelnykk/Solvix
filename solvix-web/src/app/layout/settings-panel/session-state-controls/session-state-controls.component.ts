import { Component, Input, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { MeshEditorSelectionService } from '../../../state/mesh-editor-selection.service';
import { SessionsService } from '../../../state/sessions.service';
import { SolverService } from '../../../state/solver.service';

// The state of the session: how many cubes and nodes, clearing the mesh (it can be undone) and starting the whole session over (it cannot). Each asks twice.
@Component({
  selector: 'app-session-state-controls',
  standalone: true,
  imports: [NgIf],
  templateUrl: './session-state-controls.component.html',
  styleUrl: './session-state-controls.component.scss'
})
export class SessionStateControlsComponent {
  private readonly editor = inject(MeshEditorService);
  private readonly selection = inject(MeshEditorSelectionService);
  private readonly sessions = inject(SessionsService);
  private readonly solver = inject(SolverService);

  @Input({ required: true }) sessionId!: number | null;

  isResetConfirming = false;
  isRestartConfirming = false;

  get busy(): boolean {
    return this.editor.busy();
  }

  hexCount(): number {
    return (this.sessionId === null ? null : this.editor.getState(this.sessionId))?.hexes.length ?? 0;
  }

  nodeCount(): number {
    return (this.sessionId === null ? null : this.editor.getState(this.sessionId))?.nodes.length ?? 0;
  }

  requestReset(): void {
    this.isResetConfirming = true;
  }

  cancelReset(): void {
    this.isResetConfirming = false;
  }

  requestRestart(): void {
    this.isRestartConfirming = true;
  }

  cancelRestart(): void {
    this.isRestartConfirming = false;
  }

  // "Start over": the whole session - cubes, undo history, imported reference, selection, camera - is replaced by a brand-new empty one.
  confirmRestart(): void {
    this.isRestartConfirming = false;
    if (this.sessionId !== null) {
      this.selection.clear(this.sessionId);
      this.sessions.restartSession(this.sessionId);
    }
  }

  confirmReset(): void {
    this.isResetConfirming = false;
    if (this.sessionId !== null) {
      this.editor.reset(this.sessionId);
      // the server drops the supports and loads set for the old cubes (their ids start again from 0)
      this.solver.forget(this.sessionId);
    }
  }
}
