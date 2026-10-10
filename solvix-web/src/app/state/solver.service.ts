import { Injectable, effect, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { NotificationService } from './notification.service';
import { MeshEditorService } from './mesh-editor.service';
import { HexFaceName } from '../api/mesh-editor-api.service';
import { PickedFace } from '../geometry/mesh-editor-view';
import { FACE_SCOPES, HighlightTargetsInput, MATERIAL_SCOPES, Scope, Tool, elementTargets, faceTargets, sameFace, smallFacesOf } from '../geometry/solver-targets';
import { QualityMetric } from '../geometry/quality-grading';
import {
  SolverApiService,
  SolverFaceDto,
  SolverJobDto,
  SolverMaterialDto,
  SolverQualityDto,
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
  // How opaque the cubes are drawn, 0..1 (1 = solid): lower it to see the edges and faces behind.
  opacity: number;
  // The value that gets the last colour of the ramp (null = the largest value of the field).
  colorMax: number | null;
  // The black edges of the small faces are drawn.
  edges: boolean;
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
  // What a click does (view = nothing), how far it reaches, how deep below the clicked face a material goes, and which
  // material is painted.
  tool: Tool;
  scope: Scope;
  depth: number;
  activeMaterial: string;
  // Materials whose elements are not drawn, so what is behind them shows.
  hidden: Set<string>;
  // Also draw the faces between the elements (the grid inside the body).
  showInner: boolean;
  // Colour the cubes by the quality of their worst element instead of by material.
  showQuality: boolean;
  quality: SolverQualityDto | null;
  // The Quality World: what the cubes are coloured by, the cube picked in its list, and the mesh the quality
  // above was asked for (so it is asked again when the mesh or the division changes).
  qualityMetric: QualityMetric;
  qualityHex: number | null;
  qualityKey: string | null;
  // The full-window result viewer (everything but the body and the viewing tools is gone).
  viewer: boolean;
  // The small face under the mouse.
  hover: PickedFace | null;
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
      display: { field: 'vonMises', deformationScale: 1, opacity: 1, colorMax: null, edges: true },
      viewer: false,
      tool: 'view',
      scope: 'cell',
      depth: 0,
      activeMaterial: 'rubber',
      hidden: new Set<string>(),
      showInner: false,
      showQuality: false,
      quality: null,
      qualityMetric: 'grade',
      qualityHex: null,
      qualityKey: null,
      hover: null,
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

  // The material of one small element: its own, or its cube's.
  elementMaterial(sessionId: number, hex: number, ex: number, ey: number, ez: number): string | null {
    const setup = this.entry(sessionId).setup;
    if (setup === null) return null;
    return setup.elementMaterials.find(m => m.hex === hex && m.ex === ex && m.ey === ey && m.ez === ez)?.material ?? setup.hexMaterials[hex] ?? setup.defaultMaterial;
  }

  // How many small elements have each material (the legend of the palette).
  materialCounts(sessionId: number): Map<string, number> {
    const setup = this.entry(sessionId).setup;
    const state = this.editor.getState(sessionId);
    const counts = new Map<string, number>();
    if (!setup || !state) return counts;
    const per = this.divisions(sessionId).reduce((product, n) => product * n, 1);
    const own = new Map<number, number>();
    for (const m of setup.elementMaterials) {
      counts.set(m.material, (counts.get(m.material) ?? 0) + 1);
      own.set(m.hex, (own.get(m.hex) ?? 0) + 1);
    }
    for (const hex of state.hexes) {
      const name = setup.hexMaterials[hex.id] ?? setup.defaultMaterial;
      counts.set(name, (counts.get(name) ?? 0) + per - (own.get(hex.id) ?? 0));
    }
    return counts;
  }

  isFixed(sessionId: number, hex: number, face: HexFaceName, p?: number, q?: number): boolean {
    return this.entry(sessionId).setup?.fixed.some(f => f.hex === hex && f.face === face && (p === undefined || (f.p === p && f.q === q))) ?? false;
  }

  pressureOn(sessionId: number, hex: number, face: HexFaceName, p?: number, q?: number): number | null {
    return this.entry(sessionId).setup?.loads.find(l => l.hex === hex && l.face === face && (p === undefined || (l.p === p && l.q === q)))?.pressure ?? null;
  }

  // --- view settings ---

  setField(sessionId: number, field: ResultField): void {
    this.entry(sessionId).display.field = field;
    this.entry(sessionId).display.colorMax = null; // another field, another unit
    this.touch(sessionId);
  }

  setOpacity(sessionId: number, opacity: number): void {
    if (!Number.isFinite(opacity)) return;
    this.entry(sessionId).display.opacity = Math.min(1, Math.max(0.05, opacity));
    this.touch(sessionId);
  }

  // --- the tools: what a click does ---

  tool(sessionId: number): Tool {
    return this.entry(sessionId).tool;
  }

  setTool(sessionId: number, tool: Tool): void {
    const entry = this.entry(sessionId);
    entry.tool = tool;
    // a scope that means nothing for the new tool falls back to the small one
    if (!this.scopesOf(tool).includes(entry.scope)) entry.scope = 'cell';
    entry.hover = null;
    this.touch(sessionId);
  }

  scopesOf(tool: Tool): readonly Scope[] {
    return tool === 'material' ? MATERIAL_SCOPES : tool === 'view' ? [] : FACE_SCOPES;
  }

  scope(sessionId: number): Scope {
    return this.entry(sessionId).scope;
  }

  setScope(sessionId: number, scope: Scope): void {
    this.entry(sessionId).scope = scope;
    this.touch(sessionId);
  }

  depth(sessionId: number): number {
    return this.entry(sessionId).depth;
  }

  // How many small elements below the clicked face the material reaches: 0 = the element right behind it.
  setDepth(sessionId: number, depth: number): void {
    const [nx, ny, nz] = this.divisions(sessionId);
    this.entry(sessionId).depth = Math.min(Math.max(nx, ny, nz) - 1, Math.max(0, Math.floor(depth)));
    this.touch(sessionId);
  }

  activeMaterial(sessionId: number): string {
    return this.entry(sessionId).activeMaterial;
  }

  setActiveMaterial(sessionId: number, name: string): void {
    this.entry(sessionId).activeMaterial = name;
    this.touch(sessionId);
  }

  isHidden(sessionId: number, material: string): boolean {
    return this.entry(sessionId).hidden.has(material);
  }

  hiddenMaterials(sessionId: number): ReadonlySet<string> {
    return this.entry(sessionId).hidden;
  }

  toggleHidden(sessionId: number, material: string): void {
    const hidden = this.entry(sessionId).hidden;
    if (!hidden.delete(material)) hidden.add(material);
    this.touch(sessionId);
  }

  // --- layers: named groups of cubes (enamel, dentin...) that are given a material together ---

  // The layers of the body with how many cubes each has, in order of first appearance.
  layers(sessionId: number): { name: string; hexes: number[] }[] {
    const layers = new Map<string, number[]>();
    for (const hex of this.editor.getState(sessionId)?.hexes ?? []) {
      if (!hex.layer) continue;
      (layers.get(hex.layer) ?? layers.set(hex.layer, []).get(hex.layer)!).push(hex.id);
    }
    return [...layers].map(([name, hexes]) => ({ name, hexes }));
  }

  // The material the cubes of a layer have, when they all have the same one; null when mixed.
  layerMaterial(sessionId: number, layer: string): string | null {
    const names = new Set(this.layers(sessionId).find(l => l.name === layer)?.hexes.map(h => this.materialOf(sessionId, h)));
    return names.size === 1 ? [...names][0] : null;
  }

  setLayerMaterial(sessionId: number, layer: string, material: string | null): void {
    const hexes = this.layers(sessionId).find(l => l.name === layer)?.hexes ?? [];
    this.setMaterial(sessionId, hexes, material);
  }

  // A layer named after a material of the library (enamel, dentin, pulp...) gets that material.
  applyLayerNamedMaterials(sessionId: number): void {
    const known = new Set(this.entry(sessionId).setup?.materials.map(m => m.name));
    for (const layer of this.layers(sessionId)) if (known.has(layer.name) && this.layerMaterial(sessionId, layer.name) !== layer.name) this.setLayerMaterial(sessionId, layer.name, layer.name);
  }

  // --- mesh quality ---

  quality(sessionId: number): SolverQualityDto | null {
    return this.entry(sessionId).quality;
  }

  refreshQuality(sessionId: number): void {
    this.api.quality(sessionId).subscribe({
      next: quality => {
        this.entry(sessionId).quality = quality;
        this.touch(sessionId);
      },
      error: () => this.notifications.error('Не вдалось оцінити якість сітки: сервер недоступний.')
    });
  }

  qualityMetric(sessionId: number): QualityMetric {
    return this.entry(sessionId).qualityMetric;
  }

  setQualityMetric(sessionId: number, metric: QualityMetric): void {
    this.entry(sessionId).qualityMetric = metric;
    this.touch(sessionId);
  }

  // The cube the user picked in the quality list or on the scene (null = none).
  qualityHex(sessionId: number): number | null {
    return this.entry(sessionId).qualityHex;
  }

  setQualityHex(sessionId: number, hex: number | null): void {
    const entry = this.entry(sessionId);
    entry.qualityHex = entry.qualityHex === hex ? null : hex;
    this.touch(sessionId);
  }

  // Asks for the quality again when the mesh or the division is not the one it was last asked for.
  ensureQuality(sessionId: number): void {
    const entry = this.entry(sessionId);
    const state = this.editor.getState(sessionId);
    if (!state || state.hexes.length === 0) return;
    const key = `${state.version}:${state.hexes.length}:${this.divisions(sessionId).join('x')}`;
    if (entry.qualityKey === key) return;
    entry.qualityKey = key;
    this.refreshQuality(sessionId);
  }

  showQuality(sessionId: number): boolean {
    return this.entry(sessionId).showQuality;
  }

  setShowQuality(sessionId: number, show: boolean): void {
    this.entry(sessionId).showQuality = show;
    if (show) this.refreshQuality(sessionId);
    this.touch(sessionId);
  }

  showInner(sessionId: number): boolean {
    return this.entry(sessionId).showInner;
  }

  setShowInner(sessionId: number, show: boolean): void {
    this.entry(sessionId).showInner = show;
    this.touch(sessionId);
  }

  // The small face under the mouse. Does not bump the revision: the view is not rebuilt, only its highlight redrawn.
  hover(sessionId: number): PickedFace | null {
    return this.entry(sessionId).hover;
  }

  setHover(sessionId: number, pick: PickedFace | null): boolean {
    const entry = this.entry(sessionId);
    const same = entry.hover === pick || (entry.hover !== null && pick !== null && entry.hover.hex === pick.hex && entry.hover.face === pick.face
      && entry.hover.p === pick.p && entry.hover.q === pick.q && entry.hover.inner === pick.inner && entry.hover.element?.join() === pick.element?.join());
    if (same) return false;
    entry.hover = pick;
    return true;
  }

  // What a click on the small face under the mouse would act on, for the highlight.
  highlightTargets(sessionId: number): HighlightTargetsInput | null {
    const entry = this.entry(sessionId);
    const pick = entry.hover;
    if (!pick || entry.tool === 'view') return null;
    const divisions = this.divisions(sessionId);
    if (entry.tool === 'material') {
      return { faces: [], elements: elementTargets(pick, entry.scope, entry.depth, divisions), pointed: pick };
    }
    if (pick.inner) return { faces: [], elements: [], pointed: pick };
    return { faces: faceTargets(pick, entry.scope, this.editor.getState(sessionId), divisions), elements: [], pointed: pick };
  }

  setDeformationScale(sessionId: number, scale: number): void {
    if (!Number.isFinite(scale) || scale < 0) return;
    // not a touch: the view moves its vertices in place instead of being rebuilt (see SolverRenderService)
    this.entry(sessionId).display.deformationScale = scale;
  }

  setEdges(sessionId: number, on: boolean): void {
    this.entry(sessionId).display.edges = on;
  }

  setColorMax(sessionId: number, max: number | null): void {
    if (max !== null && !(max > 0)) return;
    this.entry(sessionId).display.colorMax = max;
  }

  viewer(sessionId: number): boolean {
    return this.entry(sessionId).viewer;
  }

  setViewer(sessionId: number, on: boolean): void {
    this.entry(sessionId).viewer = on;
  }

  // The top of the deformation player: the largest displacement drawn at a quarter of the body's size - far enough
  // to follow how the body bends, short of the absurd shapes a larger factor makes.
  static maxScale(result: SolverResultDto): number {
    return SolverService.scaleFor(result, 0.25);
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

  // --- faces: the solver's way ---

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

  // The setup lists every small face, so these are the counts of the divided mesh's faces.
  loadedFaceCount(sessionId: number): number {
    return this.entry(sessionId).setup?.loads.length ?? 0;
  }

  fixedFaceCount(sessionId: number): number {
    return this.entry(sessionId).setup?.fixed.length ?? 0;
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

  // A click on the scene: with the Load or Fix tool the small faces it reaches are marked as pressed or clamped (or
  // unmarked, when they all were); with the Material tool they get the chosen material; with View nothing happens.
  pick(sessionId: number, pick: PickedFace | null): void {
    if (pick === null || pick.kind !== 'face') return;
    const entry = this.entry(sessionId);
    if (entry.tool === 'view') return;
    const divisions = this.divisions(sessionId);

    if (entry.tool === 'material') {
      const material = entry.activeMaterial;
      if (entry.scope === 'cube') {
        this.apply(sessionId, this.api.setHexMaterial(sessionId, [pick.hex], material));
      } else {
        const elements = elementTargets(pick, entry.scope, entry.depth, divisions);
        if (elements.length === 0) {
          this.notifications.warning('Там, куди сягає вибір, немає елементів: зменште глибину.');
          return;
        }
        this.apply(sessionId, this.api.setElementMaterial(sessionId, elements, material));
      }
      return;
    }

    if (pick.inner) {
      this.notifications.warning('Ця грань усередині тіла: закріплювати й навантажувати можна лише зовнішні.');
      return;
    }
    const targets = faceTargets(pick, entry.scope, this.editor.getState(sessionId), divisions);
    const small = targets.flatMap(t => smallFacesOf(t, divisions));
    if (entry.tool === 'load') {
      const marked = small.every(f => this.entry(sessionId).setup?.loads.some(l => sameFace(l, f) && l.pressure === entry.pressure));
      entry.loadSide = null;
      this.apply(sessionId, this.api.setLoads(sessionId, targets, marked ? null : entry.pressure));
    } else {
      const marked = small.every(f => this.entry(sessionId).setup?.fixed.some(x => sameFace(x, f)));
      entry.fixedChosen = true;
      entry.fixedSide = null;
      this.apply(sessionId, this.api.setFixedFaces(sessionId, targets, !marked));
    }
  }

  // Gives every cube one material (the whole body is made of it again).
  fillAll(sessionId: number, material: string): void {
    const hexes = this.editor.getState(sessionId)?.hexes.map(h => h.id) ?? [];
    if (hexes.length > 0) this.apply(sessionId, this.api.setHexMaterial(sessionId, hexes, material));
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
        entry.display.colorMax = null;
        this.touch(sessionId);
      },
      error: () => this.notifications.error('Не вдалось отримати результат розрахунку.')
    });
  }

  // A displacement that is visible: the largest one drawn at a tenth of the body's size (the real ones are
  // microscopic next to the model); never beyond the viewer's ×500000.
  static visibleScale(result: SolverResultDto): number {
    return Math.min(500000, SolverService.scaleFor(result, 0.1));
  }

  // The factor that draws the largest displacement at `fraction` of the body's size.
  static scaleFor(result: SolverResultDto, fraction: number): number {
    if (result.maxDisplacement <= 0 || result.positions.length < 3) return 1;
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < result.positions.length; i++) {
      low[i % 3] = Math.min(low[i % 3], result.positions[i]);
      high[i % 3] = Math.max(high[i % 3], result.positions[i]);
    }
    const size = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
    const scale = (fraction * size) / result.maxDisplacement;
    return scale >= 10 ? Math.round(scale / 10) * 10 : Math.round(scale * 10) / 10;
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
