import { Component, Input, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { REAL_WORLD_INDEX } from '../../../config/app-settings';
import { HexFaceName, MeshFaceDto, MeshPointDto, MeshStateDto } from '../../../api/mesh-editor-api.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { FaceRef, MeshEditorSelectionService } from '../../../state/mesh-editor-selection.service';

const FACE_LABELS: Record<HexFaceName, string> = {
  XMinus: 'X−',
  XPlus: 'X+',
  YMinus: 'Y−',
  YPlus: 'Y+',
  ZMinus: 'Z−',
  ZPlus: 'Z+'
};

type Axis = 'x' | 'y' | 'z';

// Tools of the manual hex editor: build the body cube by cube, say which
// faces are neighbours, move nodes, and probe the ideal<->real mapping. All
// geometry is decided by the backend (MeshEditorService); this only turns
// the current selection into commands. Shown in the Ideal and Real Worlds
// (the Solver World has nothing to edit); nodes only move in the Real World.
@Component({
  selector: 'app-mesh-editor-controls',
  standalone: true,
  imports: [NgIf, NgFor],
  templateUrl: './mesh-editor-controls.component.html',
  styleUrl: './mesh-editor-controls.component.scss'
})
export class MeshEditorControlsComponent {
  private readonly editor = inject(MeshEditorService);
  private readonly selection = inject(MeshEditorSelectionService);

  @Input({ required: true }) sessionId!: number | null;
  @Input({ required: true }) worldIndex!: number | null;

  adaptSecond = true;
  carryEdgeMidpoints = true;
  nudgeStep = 0.1;
  isResetConfirming = false;
  readonly axes: readonly Axis[] = ['x', 'y', 'z'];

  mappingIdeal: MeshPointDto = { x: 0.5, y: 0.5, z: 0.5 };
  mappingReal: MeshPointDto = { x: 0.5, y: 0.5, z: 0.5 };
  mappingResult: string | null = null;

  get busy(): boolean {
    return this.editor.busy();
  }

  get isRealWorld(): boolean {
    return this.worldIndex === REAL_WORLD_INDEX;
  }

  private get state(): MeshStateDto | null {
    return this.sessionId === null ? null : this.editor.getState(this.sessionId);
  }

  hexCount(): number {
    return this.state?.hexes.length ?? 0;
  }

  nodeCount(): number {
    return this.state?.nodes.length ?? 0;
  }

  canUndo(): boolean {
    return !this.busy && (this.state?.canUndo ?? false);
  }

  canRedo(): boolean {
    return !this.busy && (this.state?.canRedo ?? false);
  }

  canAddFirst(): boolean {
    return !this.busy && this.sessionId !== null && this.state !== null && this.hexCount() === 0;
  }

  // --- faces ---------------------------------------------------------------

  selectedFaces(): readonly FaceRef[] {
    return this.sessionId === null ? [] : this.selection.faces(this.sessionId);
  }

  faceLabel(face: FaceRef): string {
    return `Куб ${face.hex} · ${FACE_LABELS[face.face]}`;
  }

  faceState(face: FaceRef): MeshFaceDto | undefined {
    return this.state?.faces.find(f => f.hex === face.hex && f.face === face.face);
  }

  faceStatusText(face: FaceRef): string {
    const state = this.faceState(face);
    if (!state) {
      return '';
    }
    if (state.status === 'Linked') {
      return `з'єднана з кубом ${state.otherHex}`;
    }
    if (state.status === 'Candidate') {
      const gap = state.gap ?? 0;
      return gap <= 1e-6
        ? `поруч куб ${state.otherHex}, не сусід (грані збігаються)`
        : `поруч куб ${state.otherHex}, не сусід (зазор ${gap.toFixed(3)})`;
    }
    return 'вільна';
  }

  canAttach(): boolean {
    const faces = this.selectedFaces();
    return !this.busy && faces.length === 1 && this.faceState(faces[0])?.status === 'Free';
  }

  canLink(): boolean {
    const faces = this.selectedFaces();
    return !this.busy && faces.length === 2;
  }

  canUnlink(): boolean {
    const faces = this.selectedFaces();
    return !this.busy && faces.length === 1 && this.faceState(faces[0])?.status === 'Linked';
  }

  addFirst(): void {
    if (this.sessionId !== null) this.editor.addFirstHex(this.sessionId);
  }

  attach(): void {
    const faces = this.selectedFaces();
    if (this.sessionId !== null && faces.length === 1) {
      this.editor.addHexOnFace(this.sessionId, faces[0].hex, faces[0].face);
      this.selection.clear(this.sessionId);
    }
  }

  link(): void {
    const faces = this.selectedFaces();
    if (this.sessionId !== null && faces.length === 2) {
      this.editor.linkFaces(this.sessionId, faces[0].hex, faces[0].face, faces[1].hex, faces[1].face, this.adaptSecond);
      this.selection.clear(this.sessionId);
    }
  }

  unlink(): void {
    const faces = this.selectedFaces();
    if (this.sessionId !== null && faces.length === 1) {
      this.editor.unlinkFace(this.sessionId, faces[0].hex, faces[0].face);
      this.selection.clear(this.sessionId);
    }
  }

  clearSelection(): void {
    if (this.sessionId !== null) this.selection.clear(this.sessionId);
  }

  onAdaptChange(event: Event): void {
    this.adaptSecond = (event.target as HTMLInputElement).checked;
  }

  // --- nodes ---------------------------------------------------------------

  selectedNodeId(): number | null {
    return this.sessionId === null ? null : this.selection.nodeId(this.sessionId);
  }

  nodeCoord(axis: Axis): number {
    const id = this.selectedNodeId();
    const node = id === null ? undefined : this.state?.nodes.find(n => n.id === id);
    return node ? Math.round(node[axis] * 1e6) / 1e6 : 0;
  }

  canMoveNode(): boolean {
    return !this.busy && this.isRealWorld && this.selectedNodeId() !== null;
  }

  onCarryChange(event: Event): void {
    this.carryEdgeMidpoints = (event.target as HTMLInputElement).checked;
  }

  onNudgeStepChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > 0) this.nudgeStep = value;
  }

  onCoordChange(axis: Axis, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) {
      return;
    }
    this.moveSelectedNode({ x: this.nodeCoord('x'), y: this.nodeCoord('y'), z: this.nodeCoord('z'), [axis]: value });
  }

  nudge(axis: Axis, direction: 1 | -1): void {
    this.moveSelectedNode({
      x: this.nodeCoord('x'),
      y: this.nodeCoord('y'),
      z: this.nodeCoord('z'),
      [axis]: this.nodeCoord(axis) + direction * this.nudgeStep
    });
  }

  private moveSelectedNode(position: MeshPointDto): void {
    const id = this.selectedNodeId();
    if (this.sessionId !== null && id !== null && this.canMoveNode()) {
      this.editor.moveNode(this.sessionId, id, position, this.carryEdgeMidpoints);
    }
  }

  // --- history / reset -----------------------------------------------------

  undo(): void {
    if (this.sessionId !== null) this.editor.undo(this.sessionId);
  }

  redo(): void {
    if (this.sessionId !== null) this.editor.redo(this.sessionId);
  }

  requestReset(): void {
    this.isResetConfirming = true;
  }

  cancelReset(): void {
    this.isResetConfirming = false;
  }

  confirmReset(): void {
    this.isResetConfirming = false;
    if (this.sessionId !== null) this.editor.reset(this.sessionId);
  }

  // --- mapping probe -------------------------------------------------------

  onMappingInput(side: 'ideal' | 'real', axis: Axis, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) {
      return;
    }
    if (side === 'ideal') {
      this.mappingIdeal = { ...this.mappingIdeal, [axis]: value };
    } else {
      this.mappingReal = { ...this.mappingReal, [axis]: value };
    }
  }

  probeIdealToReal(): void {
    if (this.sessionId === null) return;
    this.editor.mapIdealToReal(this.sessionId, this.mappingIdeal).subscribe({
      next: result => (this.mappingResult = result.found && result.point ? `Real: ${this.format(result.point)}` : 'Поза тілом'),
      error: () => (this.mappingResult = 'Сервер недоступний')
    });
  }

  probeRealToIdeal(): void {
    if (this.sessionId === null) return;
    this.editor.mapRealToIdeal(this.sessionId, this.mappingReal).subscribe({
      next: result => (this.mappingResult = result.found && result.point ? `Ideal: ${this.format(result.point)}` : 'Поза тілом'),
      error: () => (this.mappingResult = 'Сервер недоступний')
    });
  }

  private format(p: MeshPointDto): string {
    return `(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)})`;
  }
}
