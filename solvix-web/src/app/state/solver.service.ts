import { Injectable, effect, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { NotificationService } from './notification.service';
import { MeshEditorService } from './mesh-editor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { HexFaceName } from '../api/mesh-editor-api.service';
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

// What is shown of a solve in the Solver World (a view setting only - nothing goes to the server).
export interface SolverDisplay {
  field: ResultField;
  // How much the displacements are exaggerated when the body is drawn deformed (0 = undeformed).
  deformationScale: number;
}

interface SessionSolver {
  setup: SolverSetupDto | null;
  validation: SolverValidationDto | null;
  job: SolverJobDto;
  result: SolverResultDto | null;
  display: SolverDisplay;
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
      display: { field: 'vonMises', deformationScale: 1 },
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

  // The picked face, only when it is a free (outer) face: a linked face is inside the body.
  private pickedOuterFace(sessionId: number): SolverFaceDto | null {
    const picked = this.selection.face(sessionId);
    if (!picked) {
      this.notifications.warning('Виберіть грань на сцені (клік по грані).');
      return null;
    }
    const face = this.editor.getState(sessionId)?.faces.find(f => f.hex === picked.hex && f.face === picked.face);
    if (face?.status === 'Linked') {
      this.notifications.warning('Ця грань усередині тіла (зв’язана з іншим кубом): закріплювати й навантажувати можна лише зовнішні.');
      return null;
    }
    return { hex: picked.hex, face: picked.face };
  }

  // Every outer face with this name - how a whole side of a body is clamped or pressed in one go.
  outerFaces(sessionId: number, face: HexFaceName): SolverFaceDto[] {
    return (this.editor.getState(sessionId)?.faces ?? []).filter(f => f.face === face && f.status !== 'Linked').map(f => ({ hex: f.hex, face: f.face }));
  }

  fixPickedFace(sessionId: number, fixed: boolean): void {
    const face = this.pickedOuterFace(sessionId);
    if (face) this.apply(sessionId, this.api.setFixedFaces(sessionId, [face], fixed));
  }

  loadPickedFace(sessionId: number, pressure: number | null): void {
    const face = this.pickedOuterFace(sessionId);
    if (face) this.apply(sessionId, this.api.setLoads(sessionId, [face], pressure));
  }

  fixSide(sessionId: number, face: HexFaceName, fixed: boolean): void {
    const faces = this.outerFaces(sessionId, face);
    if (faces.length === 0) {
      this.notifications.warning('На цьому боці немає зовнішніх граней.');
      return;
    }
    this.apply(sessionId, this.api.setFixedFaces(sessionId, faces, fixed));
  }

  loadSide(sessionId: number, face: HexFaceName, pressure: number | null): void {
    const faces = this.outerFaces(sessionId, face);
    if (faces.length === 0) {
      this.notifications.warning('На цьому боці немає зовнішніх граней.');
      return;
    }
    this.apply(sessionId, this.api.setLoads(sessionId, faces, pressure));
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

  private apply(sessionId: number, request: Observable<SolverSetupDto>): void {
    request.subscribe({
      next: setup => {
        this.acceptSetup(sessionId, setup);
        // a changed set-up makes the old verdict and result stale
        const entry = this.entry(sessionId);
        entry.validation = null;
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
        this.touch(sessionId);
      },
      error: () => this.notifications.error('Не вдалось отримати результат розрахунку.')
    });
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
