import { Injectable, effect, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { NotificationService } from './notification.service';
import { MeshEditorService } from './mesh-editor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { HexFaceName } from '../api/mesh-editor-api.service';
import { MeshPick } from '../geometry/mesh-editor-view';
import {
  SolverApiService,
  SolverFaceDto,
  SolverJobDto,
  SolverMaterialDto,
  SolverResultDto,
  SolverSetupDto,
  SolverValidationDto
} from '../api/solver-api.service';
import { SolverHubClient } from '../api/solver-hub.client';

export type ResultField = 'none' | 'vonMises' | 'displacement';

// What a click on a face does in the Solver World, as in the solver's viewer: marks it as pressed (Load) or clamped (Fix).
export type PickMode = 'load' | 'fix';

// What is shown of a solve in the Solver World (a view setting only - nothing goes to the server).
export interface SolverDisplay {
  field: ResultField;
  // How much the displacements are exaggerated when the body is drawn deformed (0 = undeformed).
  deformationScale: number;
  // How opaque the cubes are drawn, 0..1 (1 = solid): lower it to see the edges and faces behind.
  opacity: number;
}

// The six sides of a body by the solver's names: top = Z+, bottom = Z-, front = Y-, back = Y+, left = X-, right = X+.
export const SIDES: readonly { readonly face: HexFaceName; readonly label: string; readonly title: string }[] = [
  { face: 'ZPlus', label: 'Верх', title: 'Верхня сторона (Z+) — стандартний стиск' },
  { face: 'ZMinus', label: 'Низ', title: 'Нижня сторона (Z−)' },
  { face: 'YMinus', label: 'Перед', title: 'Передня сторона (Y−)' },
  { face: 'YPlus', label: 'Зад', title: 'Задня сторона (Y+)' },
  { face: 'XMinus', label: 'Ліво', title: 'Ліва сторона (X−)' },
  { face: 'XPlus', label: 'Право', title: 'Права сторона (X+)' }
];

const OPPOSITE: Record<HexFaceName, HexFaceName> = {
  XMinus: 'XPlus', XPlus: 'XMinus', YMinus: 'YPlus', YPlus: 'YMinus', ZMinus: 'ZPlus', ZPlus: 'ZMinus'
};

// The solver's default pressure: 1 MPa of compression.
export const DEFAULT_PRESSURE = -1e6;

interface SessionSolver {
  setup: SolverSetupDto | null;
  validation: SolverValidationDto | null;
  job: SolverJobDto;
  result: SolverResultDto | null;
  display: SolverDisplay;
  mode: PickMode;
  // Pn, Pa (the solver's convention: negative = compression).
  pressure: number;
  // The side chosen as a whole for the load / the clamping (null = faces picked one by one, or nothing).
  loadSide: HexFaceName | null;
  fixedSide: HexFaceName | null;
  // True once the clamped faces were chosen by the user; until then they follow the load: the opposite side.
  fixedChosen: boolean;
  // Bumps on every change a drawing of the Solver World depends on.
  revision: number;
}

const IDLE_JOB: SolverJobDto = { state: 'idle', progress: 0, stage: '', error: null, ticket: 0 };
const POLL_MS = 400;

// The client-side mirror of a session's FEM set-up and solve: which faces are clamped or pressed, which cube has
// which material, the validation verdict, the background job and its result. The backend owns all of it; this
// forwards the user's choices and keeps the latest answer. Progress arrives over SignalR, with polling as a
// fallback when the hub cannot be reached.
@Injectable({ providedIn: 'root' })
export class SolverService {
  private readonly api = inject(SolverApiService);
  private readonly hub = inject(SolverHubClient);
  private readonly sessions = inject(SessionsService);
  private readonly notifications = inject(NotificationService);
  private readonly editor = inject(MeshEditorService);
  private readonly selection = inject(MeshEditorSelectionService);
  private readonly store = new KeyedStore<number, SessionSolver>();
  private readonly requested = new Set<number>();
  private readonly polling = new Map<number, ReturnType<typeof setInterval>>();

  constructor() {
    this.hub.onJobChanged((sessionId, job) => this.acceptJob(sessionId, job));
    effect(() => {
      const ids = this.sessions.sessions().map(s => s.id);
      this.store.pruneTo(ids, (_, id) => {
        this.stopPolling(id);
        void this.hub.leave(id);
      });
      for (const id of [...this.requested]) if (!ids.includes(id)) this.requested.delete(id);
    });
  }

  private entry(sessionId: number): SessionSolver {
    return this.store.getOrCreate(sessionId, () => ({
      setup: null,
      validation: null,
      job: IDLE_JOB,
      result: null,
      display: { field: 'vonMises', deformationScale: 1, opacity: 1 },
      mode: 'load',
      pressure: DEFAULT_PRESSURE,
      loadSide: null,
      fixedSide: null,
      fixedChosen: false,
      revision: 0
    }));
  }

  // --- what the views read ---

  setup(sessionId: number): SolverSetupDto | null {
    const entry = this.entry(sessionId);
    if (entry.setup === null && !this.requested.has(sessionId)) {
      this.requested.add(sessionId);
      this.refreshSetup(sessionId);
    }
    return entry.setup;
  }

  validation(sessionId: number): SolverValidationDto | null {
    return this.entry(sessionId).validation;
  }

  job(sessionId: number): SolverJobDto {
    return this.entry(sessionId).job;
  }

  result(sessionId: number): SolverResultDto | null {
    return this.entry(sessionId).result;
  }

  display(sessionId: number): SolverDisplay {
    return this.entry(sessionId).display;
  }

  revision(sessionId: number): number {
    return this.entry(sessionId).revision;
  }

  isRunning(sessionId: number): boolean {
    return this.entry(sessionId).job.state === 'running';
  }

  // The material name a cube has (the default one unless it was given another).
  materialOf(sessionId: number, hexId: number): string | null {
    const setup = this.entry(sessionId).setup;
    return setup === null ? null : (setup.hexMaterials[hexId] ?? setup.defaultMaterial);
  }

  isFixed(sessionId: number, hex: number, face: HexFaceName): boolean {
    return this.entry(sessionId).setup?.fixed.some(f => f.hex === hex && f.face === face) ?? false;
  }

  pressureOn(sessionId: number, hex: number, face: HexFaceName): number | null {
    return this.entry(sessionId).setup?.loads.find(l => l.hex === hex && l.face === face)?.pressure ?? null;
  }

  // --- view settings ---

  setField(sessionId: number, field: ResultField): void {
    this.entry(sessionId).display.field = field;
    this.touch(sessionId);
  }

  setOpacity(sessionId: number, opacity: number): void {
    if (!Number.isFinite(opacity)) return;
    this.entry(sessionId).display.opacity = Math.min(1, Math.max(0.05, opacity));
    this.touch(sessionId);
  }

  setDeformationScale(sessionId: number, scale: number): void {
    if (!Number.isFinite(scale) || scale < 0) return;
    this.entry(sessionId).display.deformationScale = scale;
    this.touch(sessionId);
  }

  // --- set-up commands (each answers with the whole new set-up) ---

  refreshSetup(sessionId: number): void {
    this.api.getSetup(sessionId).subscribe({
      next: setup => this.acceptSetup(sessionId, setup),
      error: () => {
        this.requested.delete(sessionId);
        this.notifications.error('Не вдалось отримати налаштування розрахунку з сервера.');
      }
    });
  }

  // The mesh was reset: the server dropped the set-up of the old cubes, so forget ours and the old verdict/result.
  forget(sessionId: number): void {
    const entry = this.entry(sessionId);
    entry.setup = null;
    entry.validation = null;
    entry.result = null;
    entry.job = IDLE_JOB;
    this.requested.delete(sessionId);
    this.touch(sessionId);
  }

  upsertMaterial(sessionId: number, material: SolverMaterialDto): void {
    this.apply(sessionId, this.api.upsertMaterial(sessionId, material));
  }

  setDefaultMaterial(sessionId: number, material: string): void {
    this.apply(sessionId, this.api.setDefaultMaterial(sessionId, material));
  }

  setMaterial(sessionId: number, hexIds: readonly number[], material: string | null): void {
    if (hexIds.length > 0) this.apply(sessionId, this.api.setHexMaterial(sessionId, hexIds, material));
  }

  // The material of the picked cubes (or of every cube when none is picked).
  setMaterialOfSelection(sessionId: number, material: string): void {
    const picked = this.selection.hexes(sessionId);
    const hexes = picked.length > 0 ? picked : (this.editor.getState(sessionId)?.hexes.map(h => h.id) ?? []);
    this.setMaterial(sessionId, hexes, material);
  }

  // --- faces: the solver's way ---

  mode(sessionId: number): PickMode {
    return this.entry(sessionId).mode;
  }

  setMode(sessionId: number, mode: PickMode): void {
    this.entry(sessionId).mode = mode;
    this.touch(sessionId);
  }

  pressure(sessionId: number): number {
    return this.entry(sessionId).pressure;
  }

  loadSide(sessionId: number): HexFaceName | null {
    return this.entry(sessionId).loadSide;
  }

  // The side shown as clamped: the one the user chose, or - while none was - the opposite of the load's side.
  fixedSide(sessionId: number): HexFaceName | null {
    const entry = this.entry(sessionId);
    if (entry.fixedChosen) return entry.fixedSide;
    return entry.loadSide === null ? null : OPPOSITE[entry.loadSide];
  }

  isFixedAuto(sessionId: number): boolean {
    const entry = this.entry(sessionId);
    return !entry.fixedChosen && entry.loadSide !== null;
  }

  // The cube's number of small faces: how many elements of the divided mesh carry what is set on a cube face.
  private smallFacesPerCubeFace(sessionId: number, face: HexFaceName): number {
    const [nx, ny, nz] = this.divisions(sessionId);
    const counts = [nx, ny, nz];
    const axis = face.charCodeAt(0) - 'X'.charCodeAt(0);
    return counts.filter((_, d) => d !== axis).reduce((product, n) => product * n, 1);
  }

  loadedFaceCount(sessionId: number): number {
    return (this.entry(sessionId).setup?.loads ?? []).reduce((sum, f) => sum + this.smallFacesPerCubeFace(sessionId, f.face), 0);
  }

  fixedFaceCount(sessionId: number): number {
    return (this.entry(sessionId).setup?.fixed ?? []).reduce((sum, f) => sum + this.smallFacesPerCubeFace(sessionId, f.face), 0);
  }

  // Every outer face with this name - how a whole side of a body is chosen in one go.
  outerFaces(sessionId: number, face: HexFaceName): SolverFaceDto[] {
    return (this.editor.getState(sessionId)?.faces ?? []).filter(f => f.face === face && f.status !== 'Linked').map(f => ({ hex: f.hex, face: f.face }));
  }

  // "Навантажена грань": the whole side is pressed with the current Pn, replacing what was chosen before. If it is
  // the side that was chosen as clamped, the clamping goes back to automatic (the opposite side).
  selectLoadSide(sessionId: number, side: HexFaceName): void {
    const entry = this.entry(sessionId);
    const faces = this.outerFaces(sessionId, side);
    if (faces.length === 0) {
      this.notifications.warning('На цьому боці немає зовнішніх граней.');
      return;
    }
    entry.loadSide = side;
    if (entry.fixedChosen && entry.fixedSide === side) {
      entry.fixedChosen = false;
      entry.fixedSide = null;
    }
    this.apply(sessionId, this.api.replaceLoads(sessionId, faces, entry.pressure), () => this.followAutoFixed(sessionId));
  }

  // "Закріплена грань": the whole side is clamped; the same button again goes back to automatic.
  selectFixedSide(sessionId: number, side: HexFaceName): void {
    const entry = this.entry(sessionId);
    if (entry.fixedChosen && entry.fixedSide === side) {
      entry.fixedChosen = false;
      entry.fixedSide = null;
      this.followAutoFixed(sessionId, true);
      return;
    }
    const faces = this.outerFaces(sessionId, side);
    if (faces.length === 0) {
      this.notifications.warning('На цьому боці немає зовнішніх граней.');
      return;
    }
    entry.fixedChosen = true;
    entry.fixedSide = side;
    this.apply(sessionId, this.api.replaceFixed(sessionId, faces));
  }

  // While the clamping was not chosen it is the opposite of the load's side; with no load side, nothing is clamped.
  private followAutoFixed(sessionId: number, force = false): void {
    const entry = this.entry(sessionId);
    if (entry.fixedChosen && !force) return;
    const side = entry.loadSide === null ? null : OPPOSITE[entry.loadSide];
    const faces = side === null ? [] : this.outerFaces(sessionId, side);
    this.apply(sessionId, this.api.replaceFixed(sessionId, faces));
  }

  // Pn changes: every pressed face gets the new value.
  setPressure(sessionId: number, pressure: number): void {
    if (!Number.isFinite(pressure)) return;
    const entry = this.entry(sessionId);
    entry.pressure = pressure;
    const loaded = entry.setup?.loads ?? [];
    this.touch(sessionId);
    if (loaded.length > 0) this.apply(sessionId, this.api.replaceLoads(sessionId, loaded.map(l => ({ hex: l.hex, face: l.face })), pressure));
  }

  // A click on the scene, as in the solver's viewer: in Load mode a face is marked as pressed (or unmarked), in Fix
  // mode as clamped (or unmarked). Shift + click picks a cube instead (to give it a material).
  pick(sessionId: number, pick: MeshPick | null, additive: boolean): void {
    if (pick === null) return;
    if (additive || pick.kind !== 'face') {
      this.selection.applyPick(sessionId, pick, additive);
      return;
    }
    this.toggleFace(sessionId, { hex: pick.hex, face: pick.face });
  }

  toggleFace(sessionId: number, face: SolverFaceDto): void {
    const entry = this.entry(sessionId);
    if (this.editor.getState(sessionId)?.faces.find(f => f.hex === face.hex && f.face === face.face)?.status === 'Linked') {
      this.notifications.warning('Ця грань усередині тіла (зв’язана з іншим кубом): закріплювати й навантажувати можна лише зовнішні.');
      return;
    }
    if (entry.mode === 'load') {
      const loaded = this.pressureOn(sessionId, face.hex, face.face) !== null;
      entry.loadSide = null;
      this.apply(sessionId, this.api.setLoads(sessionId, [face], loaded ? null : entry.pressure));
    } else {
      const fixed = this.isFixed(sessionId, face.hex, face.face);
      entry.fixedChosen = true;
      entry.fixedSide = null;
      this.apply(sessionId, this.api.setFixedFaces(sessionId, [face], !fixed));
    }
  }

  // --- the division of the cubes into small elements ---

  divisions(sessionId: number): readonly number[] {
    return this.entry(sessionId).setup?.divisions ?? [1, 1, 1];
  }

  setDivisions(sessionId: number, nx: number, ny: number, nz: number): void {
    const values = [nx, ny, nz].map(n => Math.floor(n));
    if (values.some(n => !Number.isFinite(n) || n < 1 || n > 8)) return;
    this.apply(sessionId, this.api.setDivisions(sessionId, values[0], values[1], values[2]));
  }

  clearSetup(sessionId: number): void {
    this.apply(sessionId, this.api.clearSetup(sessionId));
  }

  // --- solving ---

  validate(sessionId: number): void {
    this.api.validate(sessionId).subscribe({
      next: validation => {
        this.entry(sessionId).validation = validation;
        this.touch(sessionId);
      },
      error: () => this.notifications.error('Не вдалось перевірити розрахунок: сервер недоступний.')
    });
  }

  async solve(sessionId: number): Promise<void> {
    const entry = this.entry(sessionId);
    if (entry.job.state === 'running') return;
    entry.validation = null;
    // listen first so no progress message is missed; if the hub is down, poll instead
    const live = await this.hub.join(sessionId);
    this.api.solve(sessionId).subscribe({
      next: job => {
        this.acceptJob(sessionId, job);
        if (job.state === 'running' && !live) this.startPolling(sessionId);
      },
      error: () => this.notifications.error('Не вдалось запустити розрахунок: сервер недоступний.')
    });
  }

  cancel(sessionId: number): void {
    this.api.cancel(sessionId).subscribe({
      next: job => this.acceptJob(sessionId, job),
      error: () => this.notifications.error('Не вдалось скасувати розрахунок.')
    });
  }

  clearResult(sessionId: number): void {
    const entry = this.entry(sessionId);
    entry.result = null;
    entry.job = IDLE_JOB;
    this.touch(sessionId);
  }

  // --- internals ---

  private apply(sessionId: number, request: Observable<SolverSetupDto>, then?: () => void): void {
    request.subscribe({
      next: setup => {
        this.acceptSetup(sessionId, setup);
        // a changed set-up makes the old verdict stale
        this.entry(sessionId).validation = null;
        then?.();
      },
      error: () => this.notifications.error('Не вдалось зберегти налаштування розрахунку.')
    });
  }

  private acceptSetup(sessionId: number, setup: SolverSetupDto): void {
    this.entry(sessionId).setup = setup;
    this.touch(sessionId);
  }

  private acceptJob(sessionId: number, job: SolverJobDto): void {
    const entry = this.entry(sessionId);
    // an older run's late message must not overwrite a newer one
    if (job.ticket < entry.job.ticket) return;
    entry.job = job;
    if (job.state !== 'running') {
      this.stopPolling(sessionId);
      if (job.state === 'done') this.fetchResult(sessionId, job.ticket);
      else if (job.state === 'failed' && job.error) this.notifications.warning(job.error);
    }
    this.touch(sessionId);
  }

  private fetchResult(sessionId: number, ticket: number): void {
    this.api.getResult(sessionId).subscribe({
      next: result => {
        const entry = this.entry(sessionId);
        if (result.ticket < ticket) return;
        entry.result = result;
        entry.display.deformationScale = SolverService.visibleScale(result);
        this.touch(sessionId);
      },
      error: () => this.notifications.error('Не вдалось отримати результат розрахунку.')
    });
  }

  // A displacement that is visible: the largest one drawn at a tenth of the body's size (the real ones are
  // microscopic next to the model); never beyond the viewer's ×500000.
  static visibleScale(result: SolverResultDto): number {
    if (result.maxDisplacement <= 0 || result.positions.length < 3) return 1;
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < result.positions.length; i++) {
      low[i % 3] = Math.min(low[i % 3], result.positions[i]);
      high[i % 3] = Math.max(high[i % 3], result.positions[i]);
    }
    const size = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
    const scale = (0.1 * size) / result.maxDisplacement;
    return Math.min(500000, scale >= 10 ? Math.round(scale / 10) * 10 : Math.round(scale * 10) / 10);
  }

  private startPolling(sessionId: number): void {
    this.stopPolling(sessionId);
    this.polling.set(
      sessionId,
      setInterval(() => this.api.getJob(sessionId).subscribe({ next: job => this.acceptJob(sessionId, job), error: () => undefined }), POLL_MS)
    );
  }

  private stopPolling(sessionId: number): void {
    const timer = this.polling.get(sessionId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.polling.delete(sessionId);
    }
  }

  private touch(sessionId: number): void {
    this.entry(sessionId).revision++;
  }
}
