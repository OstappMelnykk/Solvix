import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';
import { disposeObject3D } from '../geometry/dispose-object3d';
import { IDEAL_WORLD_INDEX, REAL_WORLD_INDEX } from '../config/app-settings';
import { MeshEditorService } from './mesh-editor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { SolverService } from './solver.service';
import { GeometryOpacityService } from './geometry-opacity.service';
import { NodeSizeService } from './node-size.service';
import { SurfaceAttachmentService } from './surface-attachment.service';
import { buildFemHighlight, buildFemMeshView } from '../geometry/fem-mesh-view';
import { remapMesh } from '../geometry/fem-remap';
import { SolverMeshDto } from '../api/solver-api.service';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import { MeshPick, MeshView, buildMeshView, ghostOf, withNodeMoved } from '../geometry/mesh-editor-view';

interface Cached {
  readonly key: string;
  readonly view: MeshView | null;
  // the refined mesh as this world places it, for the outline of what a pick would choose
  readonly placed?: SolverMeshDto;
}

// The 3D view of a session's mesh for one World: the Ideal World shows every
// node on its integer lattice position, the Real World at its real position;
// the Solver World shows nothing yet. Cached per (session, world) and rebuilt
// only when the server state or the selection changed - the World canvases
// ask on every change-detection pass, so identity must stay stable between
// real changes. A superseded view is NOT disposed here: the canvas that drew
// it disposes it when it swaps the new one in (same ownership rule as the
// reference overlays - a view may still be mid-render when a rebuild happens).
@Injectable({ providedIn: 'root' })
export class MeshEditorRenderService {
  private readonly editor = inject(MeshEditorService);
  private readonly selection = inject(MeshEditorSelectionService);
  private readonly solver = inject(SolverService);
  private readonly attachments = inject(SurfaceAttachmentService);
  private readonly opacity = inject(GeometryOpacityService);
  private readonly nodeSize = inject(NodeSizeService);
  private readonly cache = new Map<string, Cached>();

  // A node being dragged right now: the Real World shows it (and what follows from it) before the server has
  // answered. It drops away once the state moves on to a newer version.
  private preview: { sessionId: number; nodeId: number; position: { x: number; y: number; z: number }; carry: boolean; version: number; token: number } | null = null;
  private previewToken = 0;

  setDragPreview(sessionId: number, nodeId: number, position: { x: number; y: number; z: number }, carry: boolean): void {
    const version = this.editor.getState(sessionId)?.version;
    if (version === undefined) return;
    this.preview = { sessionId, nodeId, position, carry, version, token: ++this.previewToken };
  }

  getView(sessionId: number | null, worldIndex: number): MeshView | null {
    if (sessionId === null || (worldIndex !== IDEAL_WORLD_INDEX && worldIndex !== REAL_WORLD_INDEX)) return null;
    let state = this.editor.getState(sessionId);
    const cacheKey = `${sessionId}:${worldIndex}`;
    if (state === null || state.hexes.length === 0) {
      this.cache.delete(cacheKey);
      return null;
    }
    if (worldIndex === REAL_WORLD_INDEX && this.attachments.count(sessionId) > 0) {
      const ids = new Set(state.nodes.map(n => n.id));
      this.attachments.retain(sessionId, id => ids.has(id));
    }
    const preview = this.preview;
    if (preview && (preview.sessionId !== sessionId || preview.version !== state.version)) this.preview = null;
    const live = this.preview !== null && worldIndex === REAL_WORLD_INDEX ? this.preview : null;
    if (live) state = withNodeMoved(state, live.nodeId, live.position, live.carry);
    const key = `${live ? 'p' + live.token + ':' : ''}${state.version}:${state.hexes.length}:${this.selection.revision(sessionId)}:${this.solver.divisions(sessionId).join('x')}:${worldIndex === REAL_WORLD_INDEX ? this.attachments.revision(sessionId) : 0}:${this.selection.xrayNodes(sessionId)}:${this.opacity.get(sessionId, worldIndex)}:${this.nodeSize.get(sessionId, 'corner')}:${this.nodeSize.get(sessionId, 'mid')}:${this.solver.isLocal(sessionId) ? `local${this.solver.mesh(sessionId) ? '+' : '-'}${this.solver.revision(sessionId)}${this.solver.refineMode(sessionId)}` : ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.key === key) return cached.view;

    const view = buildMeshView(
      state,
      worldIndex === IDEAL_WORLD_INDEX ? 'ideal' : 'real',
      {
        hexes: this.selection.hexes(sessionId),
        face: this.selection.face(sessionId),
        hoverFace: this.selection.hoverFace(sessionId),
        nodeId: this.selection.nodeId(sessionId)
      },
      { subdivisions: this.solver.divisions(sessionId) as [number, number, number], attachedNodeIds: worldIndex === REAL_WORLD_INDEX ? this.attachments.attached(sessionId) : undefined, xrayNodes: this.selection.xrayNodes(sessionId), faceOpacity: this.opacity.get(sessionId, worldIndex), nodeScale: { corner: this.nodeSize.get(sessionId, 'corner'), mid: this.nodeSize.get(sessionId, 'mid') } }
    );
    const refined = this.withRefinedMesh(sessionId, worldIndex, state, view);
    this.cache.set(cacheKey, { key, view: refined.view, placed: refined.placed });
    return refined.view;
  }

  // A locally refined body: the edges of the solver's elements drawn over the cubes, the elements chosen to be refined outlined, and - while elements are being picked - the
  // faces of those elements are what a click lands on (the cubes' own faces and nodes are not).
  private withRefinedMesh(sessionId: number, worldIndex: number, state: MeshStateDto, view: MeshView): { view: MeshView | null; placed?: SolverMeshDto } {
    const mesh = this.solver.isLocal(sessionId) ? this.solver.mesh(sessionId) : null;
    const index = this.solver.meshIndex(sessionId);
    if (!mesh || !index) return { view };
    const placed = remapMesh(mesh, state, worldIndex === IDEAL_WORLD_INDEX ? 'ideal' : 'real');
    const fem = buildFemMeshView({ mesh: placed, defaultMaterial: 'steel', bodyColor: 0xffffff, opacity: 1, look: 'edges', innerEdges: true, ghostEdges: ghostOf(this.opacity.get(sessionId, worldIndex)), showFixed: false, showLoads: false });
    view.root.add(fem.root);
    const chosen = [...this.solver.refineSelection(sessionId)];
    if (chosen.length > 0) view.root.add(buildFemHighlight(placed, index, { faces: [], elements: chosen, pointed: null }, 4000));
    // what a pick would choose, outlined while the pointer is over the body (swapped in place, the view is not rebuilt)
    let hover: THREE.Object3D | null = null;
    const setHighlight = (group: THREE.Object3D | null) => {
      if (hover) {
        view.root.remove(hover);
        disposeObject3D(hover);
      }
      hover = group;
      if (group) view.root.add(group);
    };
    const shown: MeshView = { ...view, pickables: this.solver.refineMode(sessionId) ? fem.pickables : view.pickables, setHighlight };
    return { view: shown, placed };
  }

  // The pointer is over the body (or left it) while elements are being picked: outline what a click would choose.
  setRefineHover(sessionId: number, worldIndex: number, pick: MeshPick | null): void {
    const cached = this.cache.get(`${sessionId}:${worldIndex}`);
    const index = this.solver.meshIndex(sessionId);
    if (!cached?.view?.setHighlight || !cached.placed || !index) return;
    const keys = this.solver.refineMode(sessionId) && pick?.kind === 'face' ? this.solver.refineTargets(sessionId, pick) : [];
    cached.view.setHighlight(keys.length > 0 ? buildFemHighlight(cached.placed, index, { faces: [], elements: keys, pointed: null }) : null);
  }
}
