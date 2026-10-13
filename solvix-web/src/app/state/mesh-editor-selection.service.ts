import { Injectable, effect, inject } from '@angular/core';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { HexFaceName } from '../api/mesh-editor-api.service';
import { MeshPick } from '../geometry/mesh-editor-view';

export interface FaceRef {
  readonly hex: number;
  readonly face: HexFaceName;
}

interface Selection {
  hexes: number[];
  face: FaceRef | null;
  nodeId: number | null;
  hoverFace: FaceRef | null;
  // The nodes are drawn over the cubes and picked through them, so the ones inside the body can be reached.
  xray: boolean;
  // Building with the mouse, per World: right click adds a cube (on a face, or the first one on the ground), left click
  // removes one. On to begin with in the Ideal and the Real World.
  build: Record<number, boolean>;
  revision: number;
}

const MAX_HEXES = 2;

// What the user has picked in the mesh editor, per session: either one face (a
// plain click) or up to two cubes (Shift+click; in pick order - the first is
// the one a second cube is joined TO) - never both at once, picking one kind
// drops the other - plus one node, plus the face whose "add a cube here"
// button is being hovered (drawn as a preview). Purely client-side UI state - nothing
// here is sent to the server until a command uses it.
@Injectable({ providedIn: 'root' })
export class MeshEditorSelectionService {
  private readonly sessions = inject(SessionsService);
  private readonly selections = new KeyedStore<number, Selection>();

  constructor() {
    effect(() => this.selections.pruneTo(this.sessions.sessions().map(session => session.id)));
  }

  // Pick order: hexes(id)[0] is the base, [1] the one that adapts to it.
  hexes(sessionId: number): readonly number[] {
    return this.selection(sessionId).hexes;
  }

  // The face a plain click picked (what "add a cube" builds on).
  face(sessionId: number): FaceRef | null {
    return this.selection(sessionId).face;
  }

  nodeId(sessionId: number): number | null {
    return this.selection(sessionId).nodeId;
  }

  hoverFace(sessionId: number): FaceRef | null {
    return this.selection(sessionId).hoverFace;
  }

  // Bumps on every change - lets cached 3D views know to rebuild.
  revision(sessionId: number): number {
    return this.selection(sessionId).revision;
  }

  isHexSelected(sessionId: number, hexId: number): boolean {
    return this.selection(sessionId).hexes.includes(hexId);
  }

  // Picking a cube drops the picked face. Clicking a selected cube deselects it. A third cube replaces the SECOND, so
  // the first (the base the others are joined to) stays put until deselected.
  toggleHex(sessionId: number, hexId: number): void {
    const selection = this.selection(sessionId);
    selection.face = null;
    if (selection.hexes.includes(hexId)) {
      selection.hexes = selection.hexes.filter(id => id !== hexId);
    } else if (selection.hexes.length < MAX_HEXES) {
      selection.hexes = [...selection.hexes, hexId];
    } else {
      selection.hexes = [selection.hexes[0], hexId];
    }
    selection.revision++;
  }

  // Clicking the picked face again deselects it. Picking a face drops any picked cubes.
  selectFace(sessionId: number, face: FaceRef): void {
    const selection = this.selection(sessionId);
    const same = selection.face?.hex === face.hex && selection.face.face === face.face;
    selection.face = same ? null : face;
    selection.hexes = [];
    selection.revision++;
  }

  // What a click on the 3D view means: a plain click on a face picks the face,
  // Shift+click picks its cube, a node click picks the node, and a plain click
  // on empty space clears everything (Shift+click on empty space keeps it).
  applyPick(sessionId: number, pick: MeshPick | null, additive: boolean): void {
    if (pick === null) {
      if (!additive) this.clear(sessionId);
    } else if (pick.kind === 'node') {
      this.selectNode(sessionId, pick.nodeId);
    } else if (additive) {
      this.toggleHex(sessionId, pick.hex);
    } else {
      this.selectFace(sessionId, { hex: pick.hex, face: pick.face });
    }
  }

  // Exchanges which of the two cubes is the base and which one adapts.
  swapHexes(sessionId: number): void {
    const selection = this.selection(sessionId);
    if (selection.hexes.length === MAX_HEXES) {
      selection.hexes = [selection.hexes[1], selection.hexes[0]];
      selection.revision++;
    }
  }

  buildMode(sessionId: number, worldIndex: number): boolean {
    return this.selection(sessionId).build[worldIndex] ?? false;
  }

  setBuildMode(sessionId: number, worldIndex: number, on: boolean): void {
    this.selection(sessionId).build[worldIndex] = on;
  }

  xrayNodes(sessionId: number): boolean {
    return this.selection(sessionId).xray;
  }

  setXrayNodes(sessionId: number, on: boolean): void {
    const selection = this.selection(sessionId);
    if (selection.xray === on) return;
    selection.xray = on;
    selection.revision++;
  }

  selectNode(sessionId: number, nodeId: number | null): void {
    const selection = this.selection(sessionId);
    selection.nodeId = selection.nodeId === nodeId ? null : nodeId;
    selection.revision++;
  }

  setHoverFace(sessionId: number, face: FaceRef | null): void {
    const selection = this.selection(sessionId);
    const same = selection.hoverFace?.hex === face?.hex && selection.hoverFace?.face === face?.face;
    if (!same) {
      selection.hoverFace = face;
      selection.revision++;
    }
  }

  // Drops picks that no longer exist (after an undo, a delete, a reset, ...) so
  // the UI never offers a command on a cube or node the server doesn't have.
  retain(sessionId: number, hasHex: (hexId: number) => boolean, hasNode: (nodeId: number) => boolean): void {
    const selection = this.selection(sessionId);
    const hexes = selection.hexes.filter(hasHex);
    const face = selection.face !== null && hasHex(selection.face.hex) ? selection.face : null;
    const nodeId = selection.nodeId !== null && hasNode(selection.nodeId) ? selection.nodeId : null;
    const hover = selection.hoverFace !== null && hasHex(selection.hoverFace.hex) ? selection.hoverFace : null;
    if (hexes.length !== selection.hexes.length || face !== selection.face || nodeId !== selection.nodeId || hover !== selection.hoverFace) {
      selection.hexes = hexes;
      selection.face = face;
      selection.nodeId = nodeId;
      selection.hoverFace = hover;
      selection.revision++;
    }
  }

  clear(sessionId: number): void {
    const selection = this.selection(sessionId);
    selection.hexes = [];
    selection.face = null;
    selection.nodeId = null;
    selection.hoverFace = null;
    selection.revision++;
  }

  private selection(sessionId: number): Selection {
    return this.selections.getOrCreate(sessionId, () => ({ hexes: [], face: null, nodeId: null, hoverFace: null, xray: true, build: { 0: true, 1: true }, revision: 0 }));
  }
}
