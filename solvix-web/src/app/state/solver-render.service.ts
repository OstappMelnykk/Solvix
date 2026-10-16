import { Injectable, inject } from '@angular/core';
import { SOLVER_WORLD_INDEX } from '../config/app-settings';
import { MeshView } from '../geometry/mesh-editor-view';
import { buildFemHighlight, buildFemMeshView } from '../geometry/fem-mesh-view';
import { buildQualityView } from '../geometry/quality-view';
import { SolverViewInput, buildHighlight, buildSolverView, fieldRange, fieldValues, materialColor } from '../geometry/solver-view';
import { MeshEditorService } from './mesh-editor.service';
import { SolverService } from './solver.service';

// In the result viewer the supports and loads are a strong coat, clear at a glance; they can be switched off to see
// the field under them.
const VIEWER_MARKS_OPACITY = 0.85;

// The body of the Solver World while it is being set up: the Real World's look, a white-grey body (an element of another material than the
// default one has the colour of its material), the edges and no dots of the nodes.
const SETUP_BODY_COLOR = 0xe4e7eb;

interface Cached {
  readonly key: string;
  readonly view: MeshView | null;
  input: SolverViewInput;
  // what the view was last moved / coloured to (these change often and never rebuild the view)
  scale: number;
  colorMax: number | null;
  edges: boolean;
  vectors: boolean;
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
    const key = `${state.version}:${state.hexes.length}:${this.solver.revision(sessionId)}:${this.solver.viewer(sessionId)}:${this.solver.viewerMarks(sessionId)}:${this.solver.marks(sessionId, 'solver').fixed}${this.solver.marks(sessionId, 'solver').loads}:${this.solver.display(sessionId).edges}`;
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
      vectors: display.vectors,
      showFixed: this.solver.marks(sessionId, 'solver').fixed,
      showLoads: this.solver.marks(sessionId, 'solver').loads,
      marksOpacity: this.solver.viewer(sessionId) ? (this.solver.viewerMarks(sessionId) ? VIEWER_MARKS_OPACITY : 0) : undefined,
      opacity: display.opacity,
      hiddenMaterials: this.solver.hiddenMaterials(sessionId),
      showInner: this.solver.showInner(sessionId)
    };
    const mesh = this.solver.mesh(sessionId);
    // a locally refined body is drawn from the solver's own mesh of elements (until it arrives, nothing); the cached key follows the solver's revision, which the arrival bumps
    const view = this.solver.isLocal(sessionId)
      ? mesh
        ? buildFemMeshView({
            mesh,
            defaultMaterial: input.setup?.defaultMaterial ?? 'steel',
            bodyColor: SETUP_BODY_COLOR,
            opacity: input.opacity,
            hiddenMaterials: this.solver.hiddenMaterials(sessionId),
            showFixed: input.showFixed,
            showLoads: input.showLoads,
            edges: display.edges,
            edgeWidth: 1.25,
            result: input.result,
            field: input.field,
            deformationScale: input.deformationScale,
            colorMax: input.colorMax,
            vectors: input.vectors,
            marksOpacity: input.marksOpacity
          })
        : null
      : input.result
        ? buildSolverView(input)
        : this.buildSetupView(sessionId, input);
    this.cache.set(sessionId, { key, view, input, scale: display.deformationScale, colorMax: display.colorMax, edges: true, vectors: display.vectors });
    this.applyHighlight(sessionId);
    return view;
  }

  // Before there is a result: the same view as the Real and the Quality Worlds, with the materials, supports and pressures on it.
  private buildSetupView(sessionId: number, input: SolverViewInput): MeshView {
    const setup = input.setup;
    const hiddenMaterials = this.solver.hiddenMaterials(sessionId);
    const materialOf = (hex: number, ex: number, ey: number, ez: number) => this.solver.elementMaterial(sessionId, hex, ex, ey, ez);
    return buildQualityView({
      state: input.state,
      setup,
      quality: null,
      metric: 'grade',
      look: input.opacity >= 1 ? { kind: 'solid' } : { kind: 'translucent', opacity: input.opacity },
      onlyBad: false,
      showFixed: input.showFixed !== false,
      showLoads: input.showLoads !== false,
      bodyColor: SETUP_BODY_COLOR,
      colorOfElement: (hex, ex, ey, ez) => {
        const material = materialOf(hex, ex, ey, ez);
        return material !== null && material !== setup?.defaultMaterial ? materialColor(material).getHex() : null;
      },
      hidden: (hex, ex, ey, ez) => {
        const material = materialOf(hex, ex, ey, ez);
        return material !== null && hiddenMaterials.has(material);
      },
      showInner: input.showInner === true,
      dots: false,
      edges: this.solver.display(sessionId).edges
    });
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
    if (display.vectors !== cached.vectors) {
      cached.vectors = display.vectors;
      cached.view.root.traverse(o => {
        if (o.userData['vectors']) o.visible = display.vectors;
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
    if (this.solver.isLocal(sessionId)) {
      const mesh = this.solver.mesh(sessionId);
      const index = this.solver.meshIndex(sessionId);
      const wanted = this.solver.femHighlight(sessionId);
      cached.view.setHighlight(mesh && index && wanted ? buildFemHighlight(mesh, index, wanted, this.solver.isPainting(sessionId) ? 6000 : 400) : null);
      return;
    }
    const targets = this.solver.highlightTargets(sessionId);
    // a stroke can reach far more small faces than a click does
    cached.view.setHighlight(targets ? buildHighlight(cached.input, targets, this.solver.isPainting(sessionId) ? 6000 : 400) : null);
  }
}
