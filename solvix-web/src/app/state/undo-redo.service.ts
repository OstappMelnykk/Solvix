import { Injectable, inject } from '@angular/core';
import { SOLVER_WORLD_INDEX } from '../config/app-settings';
import { ActiveWorldService } from './active-world.service';
import { MeshEditorService } from './mesh-editor.service';
import { SessionsService } from './sessions.service';
import { SolverService } from './solver.service';

// The one place that answers "undo" and "redo" for the whole app, for the session and the World that are open: in the Solver
// World the last change of the set-up (supports, pressures, materials, division), everywhere else the last change of the mesh
// (a cube, a vertex...). The keys (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y) and every undo button go through it.
@Injectable({ providedIn: 'root' })
export class UndoRedoService {
  private readonly sessions = inject(SessionsService);
  private readonly worlds = inject(ActiveWorldService);
  private readonly mesh = inject(MeshEditorService);
  private readonly solver = inject(SolverService);

  private inSolverWorld(): boolean {
    return this.worlds.currentWorldIndex() === SOLVER_WORLD_INDEX;
  }

  canUndo(): boolean {
    const id = this.sessions.activeSessionId();
    if (id === null) return false;
    return this.inSolverWorld() ? this.solver.canUndoSetup(id) : !this.mesh.busy() && (this.mesh.getState(id)?.canUndo ?? false);
  }

  canRedo(): boolean {
    const id = this.sessions.activeSessionId();
    if (id === null) return false;
    return this.inSolverWorld() ? this.solver.canRedoSetup(id) : !this.mesh.busy() && (this.mesh.getState(id)?.canRedo ?? false);
  }

  undo(): boolean {
    const id = this.sessions.activeSessionId();
    if (id === null || !this.canUndo()) return false;
    if (this.inSolverWorld()) this.solver.undoSetup(id);
    else this.mesh.undo(id);
    return true;
  }

  redo(): boolean {
    const id = this.sessions.activeSessionId();
    if (id === null || !this.canRedo()) return false;
    if (this.inSolverWorld()) this.solver.redoSetup(id);
    else this.mesh.redo(id);
    return true;
  }
}
