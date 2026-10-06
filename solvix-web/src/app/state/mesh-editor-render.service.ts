import { Injectable, inject } from '@angular/core';
import { IDEAL_WORLD_INDEX, REAL_WORLD_INDEX } from '../config/app-settings';
import { MeshEditorService } from './mesh-editor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { MeshView, buildMeshView } from '../geometry/mesh-editor-view';

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
  private readonly cache = new Map<string, Cached>();

  getView(sessionId: number | null, worldIndex: number): MeshView | null {
    if (sessionId === null || (worldIndex !== IDEAL_WORLD_INDEX && worldIndex !== REAL_WORLD_INDEX)) return null;
    const state = this.editor.getState(sessionId);
    const cacheKey = `${sessionId}:${worldIndex}`;
    if (state === null || state.hexes.length === 0) {
      this.cache.delete(cacheKey);
      return null;
    }
    const key = `${state.version}:${state.hexes.length}:${this.selection.revision(sessionId)}:${this.editor.subdivisions}`;
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
      { subdivisions: this.editor.subdivisions }
    );
    this.cache.set(cacheKey, { key, view });
    return view;
  }
}
