import { Injectable, inject } from '@angular/core';
import { QUALITY_WORLD_INDEX } from '../config/app-settings';
import { MeshView } from '../geometry/mesh-editor-view';
import { SolverViewInput, buildHighlight, buildSolverView } from '../geometry/solver-view';
import { MeshEditorService } from './mesh-editor.service';
import { SolverService } from './solver.service';

interface Cached {
  readonly key: string;
  readonly view: MeshView | null;
}

// The 3D view of the Quality World: the body cut into the solver's small elements, every cube coloured by the grade
// of its worst element (or by one measure), the cube picked in the list outlined. Cached per session like the Solver
// World's view - the canvas asks on every change-detection pass, so identity has to stay stable between changes.
@Injectable({ providedIn: 'root' })
export class QualityRenderService {
  private readonly editor = inject(MeshEditorService);
  private readonly solver = inject(SolverService);
  private readonly cache = new Map<number, Cached>();

  getView(sessionId: number | null, worldIndex: number): MeshView | null {
    if (sessionId === null || worldIndex !== QUALITY_WORLD_INDEX) return null;
    const state = this.editor.getState(sessionId);
    if (state === null || state.hexes.length === 0) {
      this.cache.delete(sessionId);
      return null;
    }
    const quality = this.solver.quality(sessionId);
    const key = `${state.version}:${state.hexes.length}:${this.solver.divisions(sessionId).join('x')}:${this.solver.qualityMetric(sessionId)}:${this.solver.qualityHex(sessionId)}:${quality ? this.solver.revision(sessionId) : 'none'}`;
    const cached = this.cache.get(sessionId);
    if (cached && cached.key === key) return cached.view;

    const input: SolverViewInput = {
      state,
      setup: this.solver.setup(sessionId),
      result: null,
      field: 'none',
      deformationScale: 0,
      opacity: 1,
      quality,
      qualityMetric: this.solver.qualityMetric(sessionId)
    };
    const view = buildSolverView(input);
    const picked = this.solver.qualityHex(sessionId);
    if (picked !== null && view.setHighlight) {
      const [nx, ny, nz] = this.solver.divisions(sessionId);
      const elements: { hex: number; ex: number; ey: number; ez: number }[] = [];
      for (let ex = 0; ex < nx; ex++) for (let ey = 0; ey < ny; ey++) for (let ez = 0; ez < nz; ez++) elements.push({ hex: picked, ex, ey, ez });
      view.setHighlight(buildHighlight(input, { faces: [], elements, pointed: null }, elements.length));
    }
    this.cache.set(sessionId, { key, view });
    return view;
  }
}
