import { Injectable, inject } from '@angular/core';
import { QUALITY_WORLD_INDEX } from '../config/app-settings';
import { MeshView, buildMeshView } from '../geometry/mesh-editor-view';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import { SectionCut, SolverViewInput, buildHighlight, buildSolverView } from '../geometry/solver-view';
import { QualityExploreService, SectionSettings } from './quality-explore.service';
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
  private readonly explore = inject(QualityExploreService);
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
    const looking = this.explore.get(sessionId);
    const key = `${state.version}:${state.hexes.length}:${this.solver.divisions(sessionId).join('x')}:${this.solver.qualityMetric(sessionId)}:${JSON.stringify(this.solver.qualityPick(sessionId))}:${quality ? this.solver.revision(sessionId) : 'none'}:${this.solver.marks(sessionId, 'quality').fixed}${this.solver.marks(sessionId, 'quality').loads}:${opacity}:${this.explore.revision(sessionId)}`;
    const cached = this.cache.get(sessionId);
    if (cached && cached.key === key) return cached.view;

    // The whole body, as the Real World draws it: its lines and nodes are laid over the coloured faces. A cut or only the bad elements keep the small elements' own edges.
    const lookedAtWhole = !looking.section.enabled && !looking.onlyBad;
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
      showLoads: this.solver.marks(sessionId, 'quality').loads,
      onlyBad: looking.onlyBad,
      section: looking.section.enabled ? sectionOf(state, looking.section) : undefined,
      edges: !lookedAtWhole
    };
    const view = buildSolverView(input);
    if (lookedAtWhole) {
      const lines = buildMeshView(
        state,
        'real',
        { hexes: [], face: null, hoverFace: null, nodeId: null },
        { subdivisions: this.solver.divisions(sessionId) as [number, number, number], faces: false, pickable: false, faceOpacity: opacity }
      );
      view.root.add(lines.root);
    }
    const picked = this.solver.qualityPick(sessionId);
    if (picked !== null && view.setHighlight) view.setHighlight(buildHighlight(input, { faces: [], elements: [picked], pointed: null }));
    this.cache.set(sessionId, { key, view });
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
