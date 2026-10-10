import { Injectable, inject } from '@angular/core';
import { SOLVER_WORLD_INDEX } from '../config/app-settings';
import { MeshView } from '../geometry/mesh-editor-view';
import { SolverViewInput, buildHighlight, buildSolverView, fieldRange, fieldValues } from '../geometry/solver-view';
import { MeshEditorService } from './mesh-editor.service';
import { SolverService } from './solver.service';

// In the result viewer the supports and loads are a light coat, so the field under them stays readable.
const VIEWER_MARKS_OPACITY = 0.3;

interface Cached {
  readonly key: string;
  readonly view: MeshView | null;
  input: SolverViewInput;
  // what the view was last moved / coloured to (these change often and never rebuild the view)
  scale: number;
  colorMax: number | null;
  edges: boolean;
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
    const key = `${state.version}:${state.hexes.length}:${this.solver.revision(sessionId)}:${this.solver.viewer(sessionId)}:${this.solver.viewerMarks(sessionId)}`;
    const cached = this.cache.get(sessionId);
    if (cached && cached.key === key) {
      this.follow(sessionId, cached);
      return cached.view;
    }

    const display = this.solver.display(sessionId);
    const input: SolverViewInput = {
      state,
      setup: this.solver.setup(sessionId),
      result: this.solver.result(sessionId),
      field: display.field,
      deformationScale: display.deformationScale,
      colorMax: display.colorMax,
      marksOpacity: this.solver.viewer(sessionId) ? (this.solver.viewerMarks(sessionId) ? VIEWER_MARKS_OPACITY : 0) : undefined,
      opacity: display.opacity,
      hiddenMaterials: this.solver.hiddenMaterials(sessionId),
      showInner: this.solver.showInner(sessionId),
      quality: this.solver.showQuality(sessionId) ? this.solver.quality(sessionId) : null
    };
    const view = buildSolverView(input);
    this.cache.set(sessionId, { key, view, input, scale: display.deformationScale, colorMax: display.colorMax, edges: true });
    this.applyHighlight(sessionId);
    return view;
  }

  // The deformation and the colour range are applied in place: no rebuild, however often they change.
  private follow(sessionId: number, cached: Cached): void {
    const display = this.solver.display(sessionId);
    if (!cached.view) return;
    let changed = false;
    if (display.deformationScale !== cached.scale) {
      cached.scale = display.deformationScale;
      cached.input = { ...cached.input, deformationScale: display.deformationScale };
      cached.view.setDeformation?.(display.deformationScale);
      changed = true;
    }
    if (display.colorMax !== cached.colorMax) {
      cached.colorMax = display.colorMax;
      const result = this.solver.result(sessionId);
      const top = display.colorMax ?? (result ? this.fieldMax(sessionId) : 0);
      if (top > 0) cached.view.setColorRange?.(top);
    }
    if (display.edges !== cached.edges) {
      cached.edges = display.edges;
      cached.view.root.traverse(o => {
        if (o.userData['edges']) o.visible = display.edges;
      });
    }
    // what is outlined was built at the old scale
    if (changed) this.applyHighlight(sessionId);
  }

  private fieldMax(sessionId: number): number {
    const result = this.solver.result(sessionId);
    const values = result ? fieldValues(result, this.solver.display(sessionId).field) : null;
    return values ? fieldRange(values).max : 0;
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
