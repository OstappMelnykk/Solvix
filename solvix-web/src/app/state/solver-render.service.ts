import { Injectable, inject } from '@angular/core';
import { SOLVER_WORLD_INDEX } from '../config/app-settings';
import { MeshView } from '../geometry/mesh-editor-view';
import { buildSolverView } from '../geometry/solver-view';
import { MeshEditorService } from './mesh-editor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { SolverService } from './solver.service';

interface Cached {
  readonly key: string;
  readonly view: MeshView | null;
}

// The 3D view of a session's body in the Solver World: materials, supports and pressures while setting up,
// a field of the solution after a solve. Cached per session and rebuilt only when the mesh, the set-up, the
// result, the display settings or the selection changed (the canvas asks on every change-detection pass, so
// identity has to stay stable between real changes). A superseded view is disposed by the canvas that drew it,
// as with the mesh editor's views.
@Injectable({ providedIn: 'root' })
export class SolverRenderService {
  private readonly editor = inject(MeshEditorService);
  private readonly selection = inject(MeshEditorSelectionService);
  private readonly solver = inject(SolverService);
  private readonly cache = new Map<number, Cached>();

  getView(sessionId: number | null, worldIndex: number): MeshView | null {
    if (sessionId === null || worldIndex !== SOLVER_WORLD_INDEX) return null;
    const state = this.editor.getState(sessionId);
    if (state === null || state.hexes.length === 0) {
      this.cache.delete(sessionId);
      return null;
    }
    const key = `${state.version}:${state.hexes.length}:${this.solver.revision(sessionId)}:${this.selection.revision(sessionId)}`;
    const cached = this.cache.get(sessionId);
    if (cached && cached.key === key) return cached.view;

    const display = this.solver.display(sessionId);
    const view = buildSolverView({
      state,
      setup: this.solver.setup(sessionId),
      result: this.solver.result(sessionId),
      field: display.field,
      deformationScale: display.deformationScale,
      selectedHexes: this.selection.hexes(sessionId),
      selectedFace: this.selection.face(sessionId)
    });
    this.cache.set(sessionId, { key, view });
    return view;
  }
}
