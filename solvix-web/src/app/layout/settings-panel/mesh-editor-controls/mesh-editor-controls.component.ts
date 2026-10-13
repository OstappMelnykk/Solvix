import { Component, HostListener, Input, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { REAL_WORLD_INDEX } from '../../../config/app-settings';
import { HexFaceName, MeshPointDto, MeshStateDto } from '../../../api/mesh-editor-api.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { GeometryOpacityService } from '../../../state/geometry-opacity.service';
import { SessionsService } from '../../../state/sessions.service';
import { SurfaceAttachmentService } from '../../../state/surface-attachment.service';
import { CubeConstructorService } from '../../../state/cube-constructor.service';
import { SolverService } from '../../../state/solver.service';
import { FaceRef, MeshEditorSelectionService } from '../../../state/mesh-editor-selection.service';
import { LOCAL_COORDS } from '../../../geometry/mesh-editor-view';

const FACE_LABELS: Record<HexFaceName, string> = {
  XMinus: 'X−',
  XPlus: 'X+',
  YMinus: 'Y−',
  YPlus: 'Y+',
  ZMinus: 'Z−',
  ZPlus: 'Z+'
};

type Axis = 'x' | 'y' | 'z';

// What the info popup lists - kept next to the handler it describes
// (onKeyDown) and mirrored in docs/EDITOR_SHORTCUTS.md.
export const SHORTCUTS: readonly { readonly keys: string; readonly action: string }[] = [
  { keys: 'Клік по грані', action: 'вибрати грань' },
  { keys: 'Shift + клік', action: 'вибрати куб (1-й — основа, 2-й приєднується)' },
  { keys: 'Клік по точці', action: 'вибрати вузол (Real World: стрілки для drag)' },
  { keys: 'N', action: 'перший куб' },
  { keys: 'A', action: 'додати куб на вибрану грань' },
  { keys: 'C', action: 'конструктор куба (окреме вікно)' },
  { keys: 'L', action: 'зробити два куби сусідами' },
  { keys: 'U', action: 'розірвати сусідство' },
  { keys: 'S', action: 'поміняти місцями основу й приєднуваний' },
  { keys: 'Delete / Backspace', action: 'видалити куб' },
  { keys: 'Esc', action: 'зняти виділення' },
  { keys: 'Ctrl/Cmd + Z', action: 'скасувати' },
  { keys: 'Ctrl/Cmd + Shift + Z, Ctrl + Y', action: 'повернути' },
  { keys: '← →  ↑ ↓  PgUp PgDn', action: 'зсув вузла по X, Z, Y (Shift — ×10)' },
  { keys: '?', action: 'ця підказка' }
];

// Arrow keys move X (left/right) and Z (up = away from the viewer along -Z),
// PageUp/PageDown move Y.
const NUDGE_KEYS: Record<string, [Axis, 1 | -1]> = {
  arrowright: ['x', 1],
  arrowleft: ['x', -1],
  arrowdown: ['z', 1],
  arrowup: ['z', -1],
  pageup: ['y', 1],
  pagedown: ['y', -1]
};

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
  private readonly sessions = inject(SessionsService);
  private readonly constructorWindow = inject(CubeConstructorService);
  private readonly solver = inject(SolverService);
  private readonly attachments = inject(SurfaceAttachmentService);
  private readonly geometryOpacity = inject(GeometryOpacityService);

  @Input({ required: true }) sessionId!: number | null;
  @Input({ required: true }) worldIndex!: number | null;

  adaptSecond = true;
  nudgeStep = 0.1;
  isResetConfirming = false;
  isRestartConfirming = false;
  isHelpOpen = false;
  readonly shortcuts = SHORTCUTS;
  readonly axes: readonly Axis[] = ['x', 'y', 'z'];

  mappingIdeal: MeshPointDto = { x: 0.5, y: 0.5, z: 0.5 };
  mappingReal: MeshPointDto = { x: 0.5, y: 0.5, z: 0.5 };
  mappingResult: string | null = null;

  // Shared with the on-canvas drag gizmo (MeshEditorService.carryEdgeMidpoints).
  get carryEdgeMidpoints(): boolean {
    return this.editor.carryEdgeMidpoints;
  }

  set carryEdgeMidpoints(value: boolean) {
    this.editor.carryEdgeMidpoints = value;
  }

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

  // --- how opaque the faces of this World are ---

  opacityPercent(): number {
    return this.sessionId === null || this.worldIndex === null ? 0 : Math.round(this.geometryOpacity.get(this.sessionId, this.worldIndex) * 100);
  }

  onOpacity(event: Event): void {
    if (this.sessionId !== null && this.worldIndex !== null) this.geometryOpacity.set(this.sessionId, this.worldIndex, Number((event.target as HTMLInputElement).value) / 100);
  }

  // --- reaching the nodes inside the body ---

  xrayNodes(): boolean {
    return this.sessionId !== null && this.selection.xrayNodes(this.sessionId);
  }

  onXrayNodes(event: Event): void {
    if (this.sessionId !== null) this.selection.setXrayNodes(this.sessionId, (event.target as HTMLInputElement).checked);
  }

  // --- nodes stuck to the imported surface ---

  isNodeAttached(): boolean {
    const id = this.selectedNodeId();
    return this.sessionId !== null && id !== null && this.attachments.isAttached(this.sessionId, id);
  }

  snapEnabled(): boolean {
    return this.attachments.snapEnabled();
  }

  onSnapEnabled(event: Event): void {
    this.attachments.setSnapEnabled((event.target as HTMLInputElement).checked);
  }

  // The sensitivity: how close to the STL (in % of its size) a dragged vertex sticks.
  snapPercent(): number {
    return Math.round(this.attachments.snapShare() * 1000) / 10;
  }

  onSnapPercent(event: Event): void {
    this.attachments.setSnapShare(Number((event.target as HTMLInputElement).value) / 100);
  }

  attachedCount(): number {
    return this.sessionId === null ? 0 : this.attachments.count(this.sessionId);
  }

  detachNode(): void {
    const id = this.selectedNodeId();
    if (this.sessionId !== null && id !== null) this.attachments.detach(this.sessionId, id);
  }

  detachAllNodes(): void {
    if (this.sessionId !== null) this.attachments.detachAll(this.sessionId);
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

  // --- cubes ---------------------------------------------------------------

  readonly faceNames: readonly HexFaceName[] = ['XMinus', 'XPlus', 'YMinus', 'YPlus', 'ZMinus', 'ZPlus'];

  // The picked cubes in pick order: the first is the base, the second is joined
  // to it and adapts to it. (Clicking any face of a cube picks the cube.)
  selectedHexes(): readonly number[] {
    return this.sessionId === null ? [] : this.selection.hexes(this.sessionId);
  }

  faceLabel(face: HexFaceName): string {
    return FACE_LABELS[face];
  }

  // Who a cube touches through links, for the little summary under each pick.
  neighborsText(hexId: number): string {
    const ids = (this.state?.links ?? [])
      .filter(l => l.hexA === hexId || l.hexB === hexId)
      .map(l => (l.hexA === hexId ? l.hexB : l.hexA))
      .sort((a, b) => a - b);
    return ids.length === 0 ? 'сусідів немає' : `сусіди: ${ids.join(', ')}`;
  }

  // The link between two cubes, if they are neighbours.
  private linkBetween(a: number, b: number): { hex: number; face: HexFaceName } | null {
    const link = this.state?.links.find(l => (l.hexA === a && l.hexB === b) || (l.hexA === b && l.hexB === a));
    return link ? { hex: link.hexA, face: link.faceA } : null;
  }

  // How two cubes sit in the ideal lattice: only cubes in neighbouring cells
  // (sharing a lattice face) can be made neighbours; cubes touching just along an
  // edge or at a corner cannot, however the nodes are moved.
  pairRelation(): 'face' | 'edge' | 'corner' | 'far' | null {
    const [a, b] = this.selectedHexes();
    const hexes = this.state?.hexes;
    const first = hexes?.find(h => h.id === a);
    const second = hexes?.find(h => h.id === b);
    if (this.selectedHexes().length !== 2 || !first || !second) {
      return null;
    }
    const d = [second.cellI - first.cellI, second.cellJ - first.cellJ, second.cellK - first.cellK];
    if (d.some(x => Math.abs(x) > 1)) {
      return 'far';
    }
    const apart = d.filter(x => x !== 0).length;
    return apart === 1 ? 'face' : apart === 2 ? 'edge' : 'corner';
  }

  pairStatusText(): string {
    const [a, b] = this.selectedHexes();
    switch (this.pairRelation()) {
      case null:
        return '';
      case 'face':
        return this.linkBetween(a, b) ? 'вже сусіди' : 'ще не сусіди';
      case 'edge':
        return 'торкаються лише ребром — сусідами по грані бути не можуть';
      case 'corner':
        return 'торкаються лише вершиною — сусідами бути не можуть';
      default:
        return 'не поруч у ідеальній решітці — сусідами бути не можуть';
    }
  }

  // The way out for cubes that only touch along an edge: a cube in the cell that
  // touches both (they already share the nodes of that edge through it).
  pairAdvice(): string {
    const relation = this.pairRelation();
    return relation === 'edge' || relation === 'corner'
      ? 'Щоб з\'єднати їх, додайте між ними куб, який торкається обох гранню, і зробіть його сусідом обох.'
      : '';
  }

  // The face a plain click picked, and whether a cube can be built on it.
  activeFace(): FaceRef | null {
    return this.sessionId === null ? null : this.selection.face(this.sessionId);
  }

  activeFaceText(): string {
    const face = this.activeFace();
    if (!face) {
      return '';
    }
    const state = this.state?.faces.find(f => f.hex === face.hex && f.face === face.face);
    const status = state?.status === 'Linked' ? `з'єднана з кубом ${state.otherHex}` : state?.status === 'Candidate' ? `зайнята кубом ${state.otherHex}` : 'вільна';
    return `Куб ${face.hex} · ${FACE_LABELS[face.face]} — ${status}`;
  }

  canAttachActiveFace(): boolean {
    const face = this.activeFace();
    return !this.busy && face !== null && this.state?.faces.find(f => f.hex === face.hex && f.face === face.face)?.status === 'Free';
  }

  attachActiveFace(): void {
    const face = this.activeFace();
    if (this.sessionId !== null && face && this.canAttachActiveFace()) {
      this.editor.addHexOnFace(this.sessionId, face.hex, face.face);
      this.selection.clear(this.sessionId);
    }
  }

  // Add-a-cube buttons, one per side of the single picked cube; a side is
  // available only while nothing sits against it.
  canAttach(face: HexFaceName): boolean {
    const hexes = this.selectedHexes();
    if (this.busy || hexes.length !== 1) {
      return false;
    }
    return this.state?.faces.find(f => f.hex === hexes[0] && f.face === face)?.status === 'Free';
  }

  attach(face: HexFaceName): void {
    const hexes = this.selectedHexes();
    if (this.sessionId !== null && hexes.length === 1 && this.canAttach(face)) {
      this.editor.addHexOnFace(this.sessionId, hexes[0], face);
      this.selection.setHoverFace(this.sessionId, null);
    }
  }

  // Shows where the new cube would go while the pointer is on its button.
  previewFace(face: HexFaceName | null): void {
    const hexes = this.selectedHexes();
    if (this.sessionId === null) {
      return;
    }
    this.selection.setHoverFace(this.sessionId, face !== null && hexes.length === 1 ? { hex: hexes[0], face } : null);
  }

  canSwap(): boolean {
    return !this.busy && this.selectedHexes().length === 2;
  }

  swap(): void {
    if (this.sessionId !== null) this.selection.swapHexes(this.sessionId);
  }

  canLink(): boolean {
    const [a, b] = this.selectedHexes();
    return !this.busy && this.pairRelation() === 'face' && this.linkBetween(a, b) === null;
  }

  canUnlink(): boolean {
    const [a, b] = this.selectedHexes();
    return !this.busy && this.selectedHexes().length === 2 && this.linkBetween(a, b) !== null;
  }

  // Cubes that sit face to face but are not neighbours - the ones the user can
  // activate as neighbours (the closing cube of a ring, for example).
  candidates(): { a: number; b: number; text: string }[] {
    const faces = this.state?.faces ?? [];
    return faces
      .filter(f => f.status === 'Candidate' && f.otherHex !== null && f.hex < f.otherHex)
      .map(f => ({
        a: f.hex,
        b: f.otherHex!,
        text: (f.gap ?? 0) <= 1e-6 ? 'грані збігаються' : `зазор ${(f.gap ?? 0).toFixed(3)}`
      }));
  }

  // candidates() builds a fresh array on every change-detection pass; without
  // a stable identity per pair Angular would re-create the rows (and their
  // buttons) each pass, so a click could land on a button that was just replaced.
  trackCandidate = (_: number, candidate: { a: number; b: number }): string => `${candidate.a}-${candidate.b}`;

  linkCandidate(candidate: { a: number; b: number }): void {
    if (this.sessionId !== null) {
      this.editor.linkHexes(this.sessionId, candidate.a, candidate.b, this.adaptSecond);
    }
  }

  // Deleting acts on one cube: the single Shift-picked cube, or - when no cube
  // is picked - the cube of the face that was clicked.
  removeTarget(): number | null {
    const hexes = this.selectedHexes();
    if (hexes.length === 1) {
      return hexes[0];
    }
    return hexes.length === 0 ? (this.activeFace()?.hex ?? null) : null;
  }

  canRemove(): boolean {
    return !this.busy && this.removeTarget() !== null;
  }

  remove(): void {
    const target = this.removeTarget();
    if (this.sessionId !== null && target !== null) {
      this.editor.removeHex(this.sessionId, target);
      this.selection.clear(this.sessionId);
    }
  }

  // The constructor window: design one cube on its own (shapes, parameters, exact node
  // coordinates), then add it as the first cube or fit it onto the picked face.
  openConstructor(): void {
    if (this.sessionId !== null) {
      this.constructorWindow.open();
    }
  }

  addFirst(): void {
    if (this.sessionId !== null) this.editor.addFirstHex(this.sessionId);
  }

  // The first picked cube is the base; the second is joined to it (and, with
  // "adapt", fitted onto it). Swap exchanges the roles before linking.
  link(): void {
    const hexes = this.selectedHexes();
    if (this.sessionId !== null && hexes.length === 2) {
      this.editor.linkHexes(this.sessionId, hexes[0], hexes[1], this.adaptSecond);
      this.selection.clear(this.sessionId);
    }
  }

  unlink(): void {
    const hexes = this.selectedHexes();
    if (this.sessionId === null || hexes.length !== 2) {
      return;
    }
    const link = this.linkBetween(hexes[0], hexes[1]);
    if (link) this.editor.unlinkFace(this.sessionId, link.hex, link.face);
    this.selection.clear(this.sessionId);
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

  // The division of every cube into small elements, per axis - the solver's Nx, Ny, Nz. The same numbers draw the
  // inner grid here and cut the cubes for the solve.
  divisions(): readonly number[] {
    return this.sessionId === null ? [1, 1, 1] : this.solver.divisions(this.sessionId);
  }

  // 1 (off) to 8 small elements along an axis.
  onDivisionChange(axis: number, event: Event): void {
    if (this.sessionId === null) return;
    const value = Math.floor(Number((event.target as HTMLInputElement).value));
    if (!Number.isFinite(value)) return;
    const next = [...this.divisions()];
    next[axis] = Math.min(8, Math.max(1, value));
    this.solver.setDivisions(this.sessionId, next[0], next[1], next[2]);
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

  nudge(axis: Axis, direction: 1 | -1, multiplier = 1): void {
    this.moveSelectedNode({
      x: this.nodeCoord('x'),
      y: this.nodeCoord('y'),
      z: this.nodeCoord('z'),
      [axis]: this.nodeCoord(axis) + direction * this.nudgeStep * multiplier
    });
  }

  private moveSelectedNode(position: MeshPointDto): void {
    const id = this.selectedNodeId();
    if (this.sessionId !== null && id !== null && this.canMoveNode()) {
      this.editor.moveNode(this.sessionId, id, position, this.carryEdgeMidpoints);
    }
  }

  toggleHelp(): void {
    this.isHelpOpen = !this.isHelpOpen;
  }

  closeHelp(): void {
    this.isHelpOpen = false;
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

  requestRestart(): void {
    this.isRestartConfirming = true;
  }

  cancelRestart(): void {
    this.isRestartConfirming = false;
  }

  // "Start over": the whole session - cubes, undo history, imported reference,
  // selection, camera - is replaced by a brand-new empty one.
  confirmRestart(): void {
    this.isRestartConfirming = false;
    if (this.sessionId !== null) {
      this.selection.clear(this.sessionId);
      this.sessions.restartSession(this.sessionId);
    }
  }

  confirmReset(): void {
    this.isResetConfirming = false;
    if (this.sessionId !== null) {
      this.editor.reset(this.sessionId);
      // the server drops the supports and loads set for the old cubes (their ids start again from 0)
      this.solver.forget(this.sessionId);
    }
  }

  // --- numbering: local (inside one cube) <-> global (the mesh node) ---------------

  // The cube whose numbering is shown: the single picked cube, or the cube of the
  // picked face.
  inspectedHex(): number | null {
    return this.removeTarget();
  }

  // One row per local node 0..19: its local coordinates (alpha, beta, gamma) - the
  // arguments the shape function of that node is built from - the global id of the
  // mesh node sitting in that slot, and where it is now.
  numberingRows(): { local: number; kind: string; alpha: number; beta: number; gamma: number; node: number; x: number; y: number; z: number }[] {
    const hexId = this.inspectedHex();
    const hex = this.state?.hexes.find(h => h.id === hexId);
    if (!hex) {
      return [];
    }
    return hex.nodeIds.map((nodeId, local) => {
      const node = this.state?.nodes.find(n => n.id === nodeId);
      const [alpha, beta, gamma] = LOCAL_COORDS[local];
      return {
        local,
        kind: local < 8 ? 'кут' : 'середина ребра',
        alpha,
        beta,
        gamma,
        node: nodeId,
        x: Math.round((node?.x ?? 0) * 1e6) / 1e6,
        y: Math.round((node?.y ?? 0) * 1e6) / 1e6,
        z: Math.round((node?.z ?? 0) * 1e6) / 1e6
      };
    });
  }

  // For the selected node: the local number it has in every cube that owns it
  // (a shared node is a different local number in each cube).
  nodeOwnersText(): string {
    const id = this.selectedNodeId();
    if (id === null) {
      return '';
    }
    const owners = (this.state?.hexes ?? [])
      .map(h => ({ hex: h.id, local: h.nodeIds.indexOf(id) }))
      .filter(o => o.local >= 0)
      .map(o => `куб ${o.hex}: локальний №${o.local} (${o.local < 8 ? 'кут' : 'середина ребра'})`);
    return owners.join('; ');
  }

  // --- keyboard shortcuts --------------------------------------------------

  // Shortcuts act on the same commands as the buttons, and only when the button
  // would be enabled. Ignored while typing in a field. Listed for the user in the
  // template (and in docs): A add, Del delete, L link, U unlink, S swap, N first
  // cube, Esc clear, arrows and
  // PageUp/PageDown move the selected node (Shift = x10).
  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
      return;
    }
    if (this.sessionId === null) {
      return;
    }
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    let handled = true;

    // The help popup comes first: `?` toggles it, Esc closes it (and only it).
    if (key === '?' || (key === '/' && event.shiftKey)) {
      this.isHelpOpen = !this.isHelpOpen;
      event.preventDefault();
      return;
    }
    if (key === 'escape' && this.isHelpOpen) {
      this.isHelpOpen = false;
      event.preventDefault();
      return;
    }

    if (mod || event.altKey) {                  // (Cmd/Ctrl+Z and +Shift+Z are the whole app's: GlobalShortcutsComponent)
      handled = false;
    } else if (key === 'a') {
      if (this.canAttachActiveFace()) this.attachActiveFace();
    } else if (key === 'delete' || key === 'backspace') {
      if (this.canRemove()) this.remove();
    } else if (key === 'l') {
      if (this.canLink()) this.link();
    } else if (key === 'u') {
      if (this.canUnlink()) this.unlink();
    } else if (key === 's') {
      if (this.canSwap()) this.swap();
    } else if (key === 'c') {
      this.openConstructor();
    } else if (key === 'n') {
      if (this.canAddFirst()) this.addFirst();
    } else if (key === 'escape') {
      this.clearSelection();
    } else if (NUDGE_KEYS[key]) {
      const [axis, direction] = NUDGE_KEYS[key];
      if (this.canMoveNode()) this.nudge(axis, direction, event.shiftKey ? 10 : 1);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
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
