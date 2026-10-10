import { Injectable, inject } from '@angular/core';
import { IDEAL_WORLD_INDEX, REAL_WORLD_INDEX } from '../config/app-settings';
import { MeshEditorService } from './mesh-editor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { SolverService } from './solver.service';
import { SurfaceAttachmentService } from './surface-attachment.service';
import { MeshView, buildMeshView, withNodeMoved } from '../geometry/mesh-editor-view';

interface Cached {
  readonly key: string;
  readonly view: MeshView | null;
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
    const key = `${live ? 'p' + live.token + ':' : ''}${state.version}:${state.hexes.length}:${this.selection.revision(sessionId)}:${this.solver.divisions(sessionId).join('x')}:${worldIndex === REAL_WORLD_INDEX ? this.attachments.revision(sessionId) : 0}:${this.selection.xrayNodes(sessionId)}`;
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
      { subdivisions: this.solver.divisions(sessionId) as [number, number, number], attachedNodeIds: worldIndex === REAL_WORLD_INDEX ? this.attachments.attached(sessionId) : undefined, xrayNodes: this.selection.xrayNodes(sessionId) }
    );
    this.cache.set(cacheKey, { key, view });
    return view;
  }
}
