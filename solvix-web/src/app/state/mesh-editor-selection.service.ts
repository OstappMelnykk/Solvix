import { Injectable, effect, inject } from '@angular/core';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { HexFaceName } from '../api/mesh-editor-api.service';

export interface FaceRef {
  readonly hex: number;
  readonly face: HexFaceName;
}

interface Selection {
  faces: FaceRef[];
  nodeId: number | null;
  revision: number;
}

const MAX_FACES = 2;

// What the user has picked in the mesh editor, per session: up to two faces
// (the two clicks of a "link these faces" gesture) and one node. Purely
// client-side UI state - nothing here is sent to the server until a command
// uses it.
@Injectable({ providedIn: 'root' })
export class MeshEditorSelectionService {
  private readonly sessions = inject(SessionsService);
  private readonly selections = new KeyedStore<number, Selection>();

  constructor() {
    effect(() => this.selections.pruneTo(this.sessions.sessions().map(session => session.id)));
  }

  faces(sessionId: number): readonly FaceRef[] {
    return this.selection(sessionId).faces;
  }

  nodeId(sessionId: number): number | null {
    return this.selection(sessionId).nodeId;
  }

  // Bumps on every change - lets cached 3D views know to rebuild.
  revision(sessionId: number): number {
    return this.selection(sessionId).revision;
  }

  isFaceSelected(sessionId: number, face: FaceRef): boolean {
    return this.selection(sessionId).faces.some(f => f.hex === face.hex && f.face === face.face);
  }

  // Clicking a selected face deselects it; a third distinct face drops the
  // oldest pick, so the two newest clicks are always the pair.
  toggleFace(sessionId: number, face: FaceRef): void {
    const selection = this.selection(sessionId);
    if (this.isFaceSelected(sessionId, face)) {
      selection.faces = selection.faces.filter(f => !(f.hex === face.hex && f.face === face.face));
    } else {
      selection.faces = [...selection.faces, face].slice(-MAX_FACES);
    }
    selection.revision++;
  }

  selectNode(sessionId: number, nodeId: number | null): void {
    const selection = this.selection(sessionId);
    selection.nodeId = selection.nodeId === nodeId ? null : nodeId;
    selection.revision++;
  }

  // Drops picks that no longer exist (after an undo, a reset, ...) so the UI
  // never offers a command on a face or node the server doesn't have.
  retain(sessionId: number, hasHex: (hexId: number) => boolean, hasNode: (nodeId: number) => boolean): void {
    const selection = this.selection(sessionId);
    const faces = selection.faces.filter(f => hasHex(f.hex));
    const nodeId = selection.nodeId !== null && hasNode(selection.nodeId) ? selection.nodeId : null;
    if (faces.length !== selection.faces.length || nodeId !== selection.nodeId) {
      selection.faces = faces;
      selection.nodeId = nodeId;
      selection.revision++;
    }
  }

  clear(sessionId: number): void {
    const selection = this.selection(sessionId);
    selection.faces = [];
    selection.nodeId = null;
    selection.revision++;
  }

  private selection(sessionId: number): Selection {
    return this.selections.getOrCreate(sessionId, () => ({ faces: [], nodeId: null, revision: 0 }));
  }
}
