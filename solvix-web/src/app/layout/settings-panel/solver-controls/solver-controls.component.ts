import { Component, DoCheck, Input, inject } from '@angular/core';
import { DecimalPipe, NgFor, NgIf } from '@angular/common';
import { HexFaceName } from '../../../api/mesh-editor-api.service';
import { SolverMaterialDto } from '../../../api/solver-api.service';
import { QUALITY_WORLD_INDEX } from '../../../config/app-settings';
import { QualityDecision, decide } from '../../../geometry/quality-grading';
import { ActiveWorldService } from '../../../state/active-world.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { GRADE_COLORS, materialColor } from '../../../geometry/solver-view';
import { QualityGradeName } from '../../../api/solver-api.service';
import { ResultField, SolverService } from '../../../state/solver.service';

const MPA = 1e6;
const GPA = 1e9;

// The Solver World's panel, laid out like the solver's own sidebar: the mesh of small elements (Nx, Ny, Nz), the
// material and the load (Pn and the side that carries it, the side that is clamped), the Solve button with its
// warnings, and the results. Everything is decided on the server; this forwards the choices and shows the answers.
@Component({
  selector: 'app-solver-controls',
  standalone: true,
  imports: [NgIf, NgFor, DecimalPipe],
  templateUrl: './solver-controls.component.html',
  styleUrl: './solver-controls.component.scss'
})
export class SolverControlsComponent implements DoCheck {
  private readonly solver = inject(SolverService);
  private readonly editor = inject(MeshEditorService);
  private readonly activeWorld = inject(ActiveWorldService);

  @Input({ required: true }) sessionId!: number;

  // Form fields of the custom material (not sent until the button is pressed).
  newLabel = '';
  newYoungGPa = 70;
  newPoisson = 0.3;
  isMaterialFormOpen = false;

  // --- the mesh of small elements ---

  hexCount(): number {
    return this.editor.getState(this.sessionId)?.hexes.length ?? 0;
  }

  divisions(): readonly number[] {
    return this.solver.divisions(this.sessionId);
  }

  elementCount(): number {
    return this.hexCount() * this.divisions().reduce((product, n) => product * n, 1);
  }

  // --- materials: a palette; the active one is what the Material tool paints with ---

  setup() {
    return this.solver.setup(this.sessionId);
  }

  materials(): readonly SolverMaterialDto[] {
    return this.setup()?.materials ?? [];
  }

  defaultMaterial(): string {
    return this.setup()?.defaultMaterial ?? '';
  }

  activeMaterial(): string {
    return this.solver.activeMaterial(this.sessionId);
  }

  // Choosing a material in the palette also switches to the tool that paints with it.
  selectMaterial(name: string): void {
    this.solver.setActiveMaterial(this.sessionId, name);
    if (this.solver.tool(this.sessionId) !== 'material') this.solver.setTool(this.sessionId, 'material');
  }

  colorOf(name: string): string {
    return `#${materialColor(name).getHexString()}`;
  }

  countOf(name: string): number {
    return this.solver.materialCounts(this.sessionId).get(name) ?? 0;
  }

  isHidden(name: string): boolean {
    return this.solver.isHidden(this.sessionId, name);
  }

  toggleHidden(name: string, event: Event): void {
    event.stopPropagation();
    this.solver.toggleHidden(this.sessionId, name);
  }

  onDefaultMaterial(event: Event): void {
    this.solver.setDefaultMaterial(this.sessionId, (event.target as HTMLSelectElement).value);
  }

  // The whole body of the active material, or back to the main one.
  fillAll(): void {
    this.solver.fillAll(this.sessionId, this.activeMaterial());
  }

  resetMaterials(): void {
    this.solver.fillAll(this.sessionId, this.defaultMaterial());
  }

  canAddMaterial(): boolean {
    return this.newLabel.trim().length > 0 && this.newYoungGPa > 0 && this.newPoisson >= 0 && this.newPoisson < 0.5;
  }

  addMaterial(): void {
    if (!this.canAddMaterial()) return;
    const label = this.newLabel.trim();
    const name = `custom-${label.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/gi, '-')}`;
    this.solver.upsertMaterial(this.sessionId, { name, label, e: this.newYoungGPa * GPA, nu: this.newPoisson });
    this.solver.setActiveMaterial(this.sessionId, name);
    this.newLabel = '';
    this.isMaterialFormOpen = false;
  }

  onYoung(event: Event): void {
    this.numberField(event, value => (this.newYoungGPa = value));
  }

  onPoisson(event: Event): void {
    this.numberField(event, value => (this.newPoisson = value));
  }

  private numberField(event: Event, apply: (value: number) => void): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) apply(value);
  }

  // --- layers ---

  layers(): { name: string; hexes: number[] }[] {
    return this.solver.layers(this.sessionId);
  }

  layerMaterial(layer: string): string {
    return this.solver.layerMaterial(this.sessionId, layer) ?? '';
  }

  onLayerMaterial(layer: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value) this.solver.setLayerMaterial(this.sessionId, layer, value);
  }

  // --- mesh quality ---

  // The quality follows the mesh: it is asked again whenever the mesh or the division changed.
  ngDoCheck(): void {
    this.solver.ensureQuality(this.sessionId);
  }

  private decisionOf: { solvix: unknown; value: QualityDecision } | null = null;

  // Whether the mesh is accepted by Solvix's criterion (see decide()).
  decision(): QualityDecision | null {
    const solvix = this.solver.solvixQuality(this.sessionId);
    if (!solvix) return null;
    if (this.decisionOf?.solvix !== solvix) this.decisionOf = { solvix, value: decide(solvix) };
    return this.decisionOf.value;
  }

  openQuality(): void {
    this.activeWorld.selectCurrentWorld(QUALITY_WORLD_INDEX);
  }

  quality() {
    return this.solver.quality(this.sessionId);
  }

  refreshQuality(): void {
    this.solver.refreshQuality(this.sessionId);
  }

  showQuality(): boolean {
    return this.solver.showQuality(this.sessionId);
  }

  toggleQuality(): void {
    this.solver.setShowQuality(this.sessionId, !this.showQuality());
  }

  readonly gradeLabels: readonly { key: QualityGradeName; label: string }[] = [
    { key: 'excellent', label: 'Відмінні' },
    { key: 'good', label: 'Добрі' },
    { key: 'acceptable', label: 'Прийнятні' },
    { key: 'poor', label: 'Погані' },
    { key: 'invalid', label: 'Невалідні' }
  ];

  gradeColor(grade: QualityGradeName): string {
    return `#${GRADE_COLORS[grade].toString(16).padStart(6, '0')}`;
  }

  // The verdict in one line: can the solver be trusted with this mesh.
  qualityVerdict(): string {
    const q = this.quality();
    if (!q) return '';
    if (q.grades.invalid > 0) return `Є невалідні елементи (${q.grades.invalid}): розрахунок неможливий`;
    if (q.grades.poor > 0) return `Є погані елементи (${q.grades.poor}): напруження біля них неточні`;
    if (q.grades.acceptable > 0) return 'Сітка придатна, є елементи середньої якості';
    return 'Сітка якісна';
  }

  // --- the load and the clamping, as in the solver ---

  pressure(): number {
    return this.solver.pressure(this.sessionId);
  }

  applyPressureToAll(): void {
    this.solver.applyPressureToAll(this.sessionId);
  }

  onPressure(event: Event): void {
    this.numberField(event, value => this.solver.setPressure(this.sessionId, value));
  }








  clearSetup(): void {
    this.solver.clearSetup(this.sessionId);
  }

  // --- solving ---

  // The quality of the mesh does not stand in the way: the user decides (the verdict above only says what to expect).
  solve(): void {
    void this.solver.solve(this.sessionId);
  }

  cancel(): void {
    this.solver.cancel(this.sessionId);
  }

  isRunning(): boolean {
    return this.solver.isRunning(this.sessionId);
  }

  job() {
    return this.solver.job(this.sessionId);
  }

  progressPercent(): number {
    return Math.round(this.job().progress * 100);
  }

  jobText(): string {
    const job = this.job();
    switch (job.state) {
      case 'running':
        return `${job.stage} — ${this.progressPercent()}%`;
      case 'done':
        return 'Розрахунок завершено';
      case 'failed':
        return job.error ?? 'Розрахунок не вдався';
      case 'cancelled':
        return 'Розрахунок скасовано';
      default:
        return '';
    }
  }

  // --- the results ---

  result() {
    return this.solver.result(this.sessionId);
  }

  display() {
    return this.solver.display(this.sessionId);
  }

  onField(event: Event): void {
    this.solver.setField(this.sessionId, (event.target as HTMLSelectElement).value as ResultField);
  }

  clearResult(): void {
    this.solver.clearResult(this.sessionId);
  }

  // The summary table: what the solver shows after a solve.
  summary(): { label: string; value: string; title: string }[] {
    const result = this.result();
    if (!result) return [];
    const sci = (v: number, digits: number) => v.toExponential(digits);
    return [
      { label: 'Min uz', value: sci(Math.min(...result.uz), 4), title: 'Мінімальне переміщення uz по всіх вузлах' },
      { label: 'Max |u|', value: sci(result.maxDisplacement, 4), title: 'Максимальна довжина вектора переміщення' },
      { label: 'Max σ_vm', value: `${sci(result.maxVonMises, 3)} Па`, title: 'Максимальне напруження за Мізесом' },
      { label: 'Min σ_vm', value: `${sci(Math.min(...result.vonMises), 3)} Па`, title: 'Мінімальне напруження за Мізесом' },
      { label: 'Вузлів СЕ', value: String(result.ux.length), title: 'Вузли сітки, на якій розв\'язано задачу' },
      { label: 'Час', value: `${result.elapsedSeconds.toFixed(2)} с`, title: 'Час розрахунку' }
    ];
  }

  // The pressure of a MPa value, for the hint under the Pn field.
  pressureHint(): string {
    const p = this.pressure();
    return p < 0 ? `стиск, ${(-p / MPA).toPrecision(3)} МПа` : p > 0 ? `розтяг, ${(p / MPA).toPrecision(3)} МПа` : 'немає навантаження';
  }
}
