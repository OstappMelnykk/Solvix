import { Injectable, inject } from '@angular/core';
import { QUALITY_WORLD_INDEX } from '../config/app-settings';
import { MeshView } from '../geometry/mesh-editor-view';
import { SolverViewInput, buildHighlight, buildSolverView } from '../geometry/solver-view';
import { GeometryOpacityService } from './geometry-opacity.service';
import { MeshEditorService } from './mesh-editor.service';
import { SolverService } from './solver.service';

interface Cached {
  readonly key: string;
  readonly view: MeshView | null;
}

// The 3D view of the Quality World: the body cut into the solver's small elements, every small element coloured by its grade
// (or by one measure), the element picked in the list outlined. Cached per session like the Solver
// World's view - the canvas asks on every change-detection pass, so identity has to stay stable between changes.
@Injectable({ providedIn: 'root' })
export class QualityRenderService {
  private readonly editor = inject(MeshEditorService);
  private readonly solver = inject(SolverService);
  private readonly geometryOpacity = inject(GeometryOpacityService);
  private readonly cache = new Map<number, Cached>();

  getView(sessionId: number | null, worldIndex: number): MeshView | null {
    if (sessionId === null || worldIndex !== QUALITY_WORLD_INDEX) return null;
    const state = this.editor.getState(sessionId);
    if (state === null || state.hexes.length === 0) {
      this.cache.delete(sessionId);
      return null;
    }
    const quality = this.solver.quality(sessionId);
    const opacity = this.geometryOpacity.get(sessionId, worldIndex);
    const key = `${state.version}:${state.hexes.length}:${this.solver.divisions(sessionId).join('x')}:${this.solver.qualityMetric(sessionId)}:${JSON.stringify(this.solver.qualityPick(sessionId))}:${quality ? this.solver.revision(sessionId) : 'none'}:${this.solver.marks(sessionId, 'quality').fixed}${this.solver.marks(sessionId, 'quality').loads}:${opacity}`;
    const cached = this.cache.get(sessionId);
    if (cached && cached.key === key) return cached.view;

    const input: SolverViewInput = {
      state,
      setup: this.solver.setup(sessionId),
      result: null,
      field: 'none',
      deformationScale: 0,
      opacity,
      quality,
      qualityMetric: this.solver.qualityMetric(sessionId),
      showFixed: this.solver.marks(sessionId, 'quality').fixed,
      showLoads: this.solver.marks(sessionId, 'quality').loads
    };
    const view = buildSolverView(input);
    const picked = this.solver.qualityPick(sessionId);
    if (picked !== null && view.setHighlight) view.setHighlight(buildHighlight(input, { faces: [], elements: [picked], pointed: null }));
    this.cache.set(sessionId, { key, view });
    return view;
  }
}
