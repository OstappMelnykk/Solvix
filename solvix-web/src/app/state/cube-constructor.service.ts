import { Injectable, inject, signal } from '@angular/core';
import { LOCAL_COORDS } from '../geometry/mesh-editor-view';
import {
  HexFaceName,
  MeshEditorApiService,
  MeshPointDto,
  MeshShapeCheckDto,
  MeshShapeDto,
  MeshShapeParametersDto,
  MeshShapePresetDto
} from '../api/mesh-editor-api.service';
import { MeshEditorService } from './mesh-editor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { NotificationService } from './notification.service';
import { SessionsService } from './sessions.service';

export const UNIT_PARAMETERS: MeshShapeParametersDto = { length: 1, height: 1, depth: 1, taper: 1, shearX: 0, shearZ: 0 };

// The regular unit cube: node `slot` at its local coordinates mapped from [-1,1] to [0,1].
export function unitPositions(): MeshPointDto[] {
  return LOCAL_COORDS.map(([a, b, g]) => ({ x: (a + 1) / 2, y: (b + 1) / 2, z: (g + 1) / 2 }));
}

export type ConstructorTarget =
  | { readonly kind: 'first'; readonly text: string }
  | { readonly kind: 'face'; readonly hex: number; readonly face: HexFaceName; readonly text: string }
  | { readonly kind: 'none'; readonly text: string };

const PARAMETER_KEYS: readonly (keyof MeshShapeParametersDto)[] = ['length', 'height', 'depth', 'taper', 'shearX', 'shearZ'];
const CHECK_DELAY_MS = 250;

// The cube constructor's draft: one cube designed on its own - the 20 node
// positions, the parameters it was generated from, the picked node - before it
// is attached to the body. App-wide (a draft survives closing the window and
// switching sessions); the shapes themselves come from the backend (presets,
// the parametric block, the validity check), this only holds and edits them.
@Injectable({ providedIn: 'root' })
export class CubeConstructorService {
  private readonly api = inject(MeshEditorApiService);
  private readonly editor = inject(MeshEditorService);
  private readonly selection = inject(MeshEditorSelectionService);
  private readonly sessions = inject(SessionsService);
  private readonly notifications = inject(NotificationService);

  readonly isOpen = signal(false);
  readonly presets = signal<readonly MeshShapePresetDto[]>([]);

  positions: MeshPointDto[] = unitPositions();
  parameters: MeshShapeParametersDto = { ...UNIT_PARAMETERS };
  selectedSlot: number | null = null;
  check: MeshShapeCheckDto | null = null;
  // Bumps on every change to the positions or the picked node - what the 3D view caches on.
  revision = 0;
  // Bumps only when the whole shape is replaced (a preset, applied parameters, reset) - the
  // views re-frame the cube then, and NOT while a node is being dragged.
  frameRevision = 0;

  private checkTimer: ReturnType<typeof setTimeout> | null = null;

  open(): void {
    this.isOpen.set(true);
    if (this.presets().length === 0) {
      this.loadPresets();
    }
    this.runCheck();
  }

  close(): void {
    this.isOpen.set(false);
    if (this.checkTimer !== null) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  loadPresets(): void {
    this.api.shapePresets().subscribe({
      next: presets => this.presets.set(presets),
      error: () => this.notifications.error('Не вдалось отримати бібліотеку форм із сервера.')
    });
  }

  // Replaces the draft with a library shape (its parameters fill the fields too).
  applyPreset(name: string): void {
    const preset = this.presets().find(p => p.name === name);
    if (!preset) {
      return;
    }
    this.parameters = { ...preset.parameters };
    this.applyParameters();
  }

  setParameter(key: keyof MeshShapeParametersDto, value: number): void {
    if (PARAMETER_KEYS.includes(key) && Number.isFinite(value)) {
      this.parameters = { ...this.parameters, [key]: value };
    }
  }

  // Builds the block described by the parameter fields (the server does the maths)
  // and makes it the draft.
  applyParameters(): void {
    this.api.buildShape(this.parameters).subscribe({
      next: shape => {
        this.positions = shape.positions.map(p => ({ x: p.x, y: p.y, z: p.z }));
        this.selectedSlot = null;
        this.frameRevision++;
        this.changed();
      },
      error: () => this.notifications.error('Не вдалось побудувати форму: сервер недоступний.')
    });
  }

  resetToUnit(): void {
    this.parameters = { ...UNIT_PARAMETERS };
    this.positions = unitPositions();
    this.selectedSlot = null;
    this.frameRevision++;
    this.changed();
  }

  selectSlot(slot: number | null): void {
    if (this.selectedSlot !== slot) {
      this.selectedSlot = slot;
      this.revision++;
    }
  }

  // Moves one of the 20 nodes (a dragged dot or a typed coordinate). Non-numbers are ignored.
  setNodePosition(slot: number, position: MeshPointDto): void {
    if (slot < 0 || slot >= this.positions.length || ![position.x, position.y, position.z].every(Number.isFinite)) {
      return;
    }
    this.positions = this.positions.map((p, i) => (i === slot ? { x: position.x, y: position.y, z: position.z } : p));
    this.changed();
  }

  shape(): MeshShapeDto {
    return { positions: this.positions.map(p => ({ ...p })) };
  }

  // Where "add" would put the cube: the first cube of an empty body, or the face
  // picked on the scene; otherwise the user has to pick a free face first.
  target(): ConstructorTarget {
    const sessionId = this.sessions.activeSessionId();
    const state = sessionId === null ? null : this.editor.getState(sessionId);
    if (sessionId === null || state === null) {
      return { kind: 'none', text: 'Немає відкритої сесії.' };
    }
    if (state.hexes.length === 0) {
      return { kind: 'first', text: 'Стане першим кубом тіла.' };
    }
    const picked = this.selection.face(sessionId);
    if (!picked) {
      return { kind: 'none', text: 'Закрийте конструктор, виберіть вільну грань на сцені і відкрийте його знову.' };
    }
    const free = state.faces.find(f => f.hex === picked.hex && f.face === picked.face)?.status === 'Free';
    return free
      ? { kind: 'face', hex: picked.hex, face: picked.face, text: `Приєднається до грані ${picked.face} куба ${picked.hex}.` }
      : { kind: 'none', text: 'Вибрана грань зайнята: виберіть вільну.' };
  }

  // Sends the draft to the body: as the first cube, or fitted onto the picked face.
  confirm(): void {
    const sessionId = this.sessions.activeSessionId();
    const target = this.target();
    if (sessionId === null || target.kind === 'none') {
      this.notifications.warning(target.text);
      return;
    }
    if (target.kind === 'first') {
      this.editor.addFirstHex(sessionId, this.shape());
    } else {
      this.editor.addHexOnFace(sessionId, target.hex, target.face, this.shape());
    }
    this.selection.clear(sessionId);
    this.close();
  }

  // Asks the server whether the draft is a valid element (positive Jacobian).
  runCheck(): void {
    this.api.checkShape(this.shape()).subscribe({
      next: result => (this.check = result),
      error: () => (this.check = null)
    });
  }

  private changed(): void {
    this.revision++;
    if (this.checkTimer !== null) {
      clearTimeout(this.checkTimer);
    }
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      this.runCheck();
    }, CHECK_DELAY_MS);
  }
}
