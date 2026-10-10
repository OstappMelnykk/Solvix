import { Injectable, inject } from '@angular/core';
import { SOLVER_WORLD_INDEX } from '../config/app-settings';
import { MeshView } from '../geometry/mesh-editor-view';
import { SolverViewInput, buildHighlight, buildSolverView } from '../geometry/solver-view';
import { MeshEditorService } from './mesh-editor.service';
import { SolverService } from './solver.service';

interface Cached {
  readonly key: string;
  readonly view: MeshView | null;
  readonly input: SolverViewInput;
}

// The 3D view of a session's body in the Solver World: materials, supports and pressures while setting up, a field
// of the solution after a solve. Cached per session and rebuilt only when the mesh, the set-up, the result or the
// display settings changed (the canvas asks on every change-detection pass, so identity has to stay stable between
// real changes). What a click would act on is drawn into the cached view as a highlight, without rebuilding it. A
// superseded view is disposed by the canvas that drew it, as with the mesh editor's views.
@Injectable({ providedIn: 'root' })
export class SolverRenderService {
  private readonly editor = inject(MeshEditorService);
  private readonly solver = inject(SolverService);
  private readonly cache = new Map<number, Cached>();

  getView(sessionId: number | null, worldIndex: number): MeshView | null {
    if (sessionId === null || worldIndex !== SOLVER_WORLD_INDEX) return null;
    const state = this.editor.getState(sessionId);
    if (state === null || state.hexes.length === 0) {
      this.cache.delete(sessionId);
      return null;
    }
    const key = `${state.version}:${state.hexes.length}:${this.solver.revision(sessionId)}`;
    const cached = this.cache.get(sessionId);
    if (cached && cached.key === key) return cached.view;

    const display = this.solver.display(sessionId);
    const input: SolverViewInput = {
      state,
      setup: this.solver.setup(sessionId),
      result: this.solver.result(sessionId),
      field: display.field,
      deformationScale: display.deformationScale,
      opacity: display.opacity,
      hiddenMaterials: this.solver.hiddenMaterials(sessionId),
      showInner: this.solver.showInner(sessionId),
      quality: this.solver.showQuality(sessionId) ? this.solver.quality(sessionId) : null
    };
    const view = buildSolverView(input);
    this.cache.set(sessionId, { key, view, input });
    this.applyHighlight(sessionId);
    return view;
  }

  // Redraws what a click would act on (the pointer moved, or the tool changed) - the view itself stays.
  refreshHighlight(sessionId: number): void {
    this.applyHighlight(sessionId);
  }

  private applyHighlight(sessionId: number): void {
    const cached = this.cache.get(sessionId);
    if (!cached?.view?.setHighlight) return;
    const targets = this.solver.highlightTargets(sessionId);
    cached.view.setHighlight(targets ? buildHighlight(cached.input, targets) : null);
  }
}
