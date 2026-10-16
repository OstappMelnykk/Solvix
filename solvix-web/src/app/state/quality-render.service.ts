import { Injectable, inject } from '@angular/core';
import { QUALITY_WORLD_INDEX } from '../config/app-settings';
import { MeshView } from '../geometry/mesh-editor-view';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import { buildFemHighlight, buildFemMeshView } from '../geometry/fem-mesh-view';
import { RESULT_COLORS } from '../geometry/solver-view';
import { measuredGrade, resultOf } from '../geometry/quality-grading';
import { buildQualityView } from '../geometry/quality-view';
import { SectionCut, SolverViewInput, buildHighlight } from '../geometry/solver-view';
import { QualityExploreService, SectionSettings } from './quality-explore.service';
import { MeshEditorService } from './mesh-editor.service';
import { NodeSizeService } from './node-size.service';
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
  private readonly explore = inject(QualityExploreService);
  private readonly nodeSize = inject(NodeSizeService);
  private readonly cache = new Map<number, Cached>();

  getView(sessionId: number | null, worldIndex: number): MeshView | null {
    if (sessionId === null || worldIndex !== QUALITY_WORLD_INDEX) return null;
    const state = this.editor.getState(sessionId);
    if (state === null || state.hexes.length === 0) {
      this.cache.delete(sessionId);
      return null;
    }
    const quality = this.solver.quality(sessionId);
    const looking = this.explore.get(sessionId);
    const key = `${state.version}:${state.hexes.length}:${this.solver.divisions(sessionId).join('x')}:${this.solver.qualityMetric(sessionId)}:${JSON.stringify(this.solver.qualityPick(sessionId))}:${quality ? this.solver.revision(sessionId) : 'none'}:${this.solver.marks(sessionId, 'quality').fixed}${this.solver.marks(sessionId, 'quality').loads}:${this.explore.revision(sessionId)}:${this.nodeSize.get(sessionId, 'corner')}:${this.nodeSize.get(sessionId, 'mid')}:${this.solver.isLocal(sessionId) ? 'local' + (this.solver.mesh(sessionId) ? '+' : '-') : ''}`;
    const cached = this.cache.get(sessionId);
    if (cached && cached.key === key) return cached.view;

    const input: SolverViewInput = {
      state,
      setup: this.solver.setup(sessionId),
      result: null,
      field: 'none',
      deformationScale: 0,
      opacity: 1
    };
    const marks = this.solver.marks(sessionId, 'quality');
    if (this.solver.isLocal(sessionId)) {
      const view = this.buildLocalView(sessionId, input, looking.filled ? 'solid' : 'edges', looking.onlyBad);
      this.cache.set(sessionId, { key, view });
      return view;
    }
    const view = buildQualityView({
      state,
      setup: input.setup,
      quality,
      metric: this.solver.qualityMetric(sessionId),
      look: looking.filled ? { kind: 'solid' } : { kind: 'edges' },
      onlyBad: looking.onlyBad,
      section: looking.section.enabled ? sectionOf(state, looking.section) : undefined,
      nodeScale: { corner: this.nodeSize.get(sessionId, 'corner'), mid: this.nodeSize.get(sessionId, 'mid') },
      showFixed: marks.fixed,
      showLoads: marks.loads
    });
    const picked = this.solver.qualityPick(sessionId);
    if (picked !== null && view.setHighlight) view.setHighlight(buildHighlight(input, { faces: [], elements: [picked], pointed: null }));
    this.cache.set(sessionId, { key, view });
    return view;
  }

  // A locally refined body: the solver's own mesh of elements, every element in the colour of its grade (a null view until the mesh has arrived).
  private buildLocalView(sessionId: number, input: SolverViewInput, look: 'solid' | 'edges', onlyBad: boolean): MeshView | null {
    const mesh = this.solver.mesh(sessionId);
    const index = this.solver.meshIndex(sessionId);
    if (!mesh || !index) return null;
    const quality = this.solver.quality(sessionId);
    const metric = this.solver.qualityMetric(sessionId);
    // an element not listed is graded excellent
    const grades = quality ? new Map(quality.flagged.filter(e => e.key !== undefined).map(e => [e.key!, measuredGrade(e, metric, quality.limits)])) : null;
    const rejected = (element: number) => !!grades && resultOf(grades.get(mesh.keys[element]) ?? 'excellent') === 'rejected';
    const marks = this.solver.marks(sessionId, 'quality');
    const view = buildFemMeshView({
      mesh,
      defaultMaterial: input.setup?.defaultMaterial ?? 'steel',
      bodyColor: 0x4a8fe3,
      opacity: 1,
      look,
      edgeWidth: 1.8,
      showFixed: marks.fixed,
      showLoads: marks.loads,
      elementColor: element => (grades ? RESULT_COLORS[rejected(element) ? 'rejected' : 'accepted'] : null),
      skipElement: element => onlyBad && !!grades && !rejected(element),
      // the edges inside the body show in the edges look; a bad element is shown whole, not only where it is on the surface
      innerEdges: look === 'edges',
      allFaces: onlyBad,
      rank: element => (rejected(element) ? 1 : 0)
    });
    const picked = this.solver.qualityPick(sessionId);
    if (picked?.key != null && view.setHighlight) view.setHighlight(buildFemHighlight(mesh, index, { faces: [], elements: [picked.key], pointed: null }));
    return view;
  }
}

// The plane of a cut in real coordinates: its place is a fraction of the body's extent along the axis.
export function sectionOf(state: MeshStateDto, section: SectionSettings): SectionCut {
  const along = (n: { x: number; y: number; z: number }) => (section.axis === 0 ? n.x : section.axis === 1 ? n.y : n.z);
  const values = state.nodes.map(along);
  const low = Math.min(...values), high = Math.max(...values);
  return { axis: section.axis, at: low + (high - low) * section.position, keep: section.keep };
}
