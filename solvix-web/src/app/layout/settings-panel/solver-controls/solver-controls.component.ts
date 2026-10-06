import { Component, Input, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { FACE_NAMES } from '../../../geometry/mesh-editor-view';
import { HexFaceName } from '../../../api/mesh-editor-api.service';
import { SolverMaterialDto } from '../../../api/solver-api.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { MeshEditorSelectionService } from '../../../state/mesh-editor-selection.service';
import { ResultField, SolverService } from '../../../state/solver.service';
import { fieldRange, fieldValues, rampColor } from '../../../geometry/solver-view';

const MPA = 1e6;
const GPA = 1e9;

export const SIDE_LABELS: Record<HexFaceName, string> = {
  XMinus: 'X− (ліворуч)',
  XPlus: 'X+ (праворуч)',
  YMinus: 'Y− (низ)',
  YPlus: 'Y+ (верх)',
  ZMinus: 'Z− (ззаду)',
  ZPlus: 'Z+ (спереду)'
};

// The Solver World's panel: what to solve (a material per cube, clamped faces, pressures), whether it can be
// solved, the solve itself with its progress, and how the solution is shown. Everything is decided on the
// server; this forwards the choices and shows the answers.
@Component({
  selector: 'app-solver-controls',
  standalone: true,
  imports: [NgIf, NgFor],
  templateUrl: './solver-controls.component.html',
  styleUrl: './solver-controls.component.scss'
})
export class SolverControlsComponent {
  private readonly solver = inject(SolverService);
  private readonly editor = inject(MeshEditorService);
  private readonly selection = inject(MeshEditorSelectionService);

  @Input({ required: true }) sessionId!: number;

  readonly sides = FACE_NAMES;
  readonly sideLabels = SIDE_LABELS;
  // Form fields (not sent anywhere until a button is pressed).
  side: HexFaceName = 'ZMinus';
  pressureMPa = 1;
  newLabel = '';
  newYoungGPa = 70;
  newPoisson = 0.3;
  isMaterialFormOpen = false;

  // --- stats and set-up ---

  hexCount(): number {
    return this.editor.getState(this.sessionId)?.hexes.length ?? 0;
  }

  setup() {
    return this.solver.setup(this.sessionId);
  }

  materials(): readonly SolverMaterialDto[] {
    return this.setup()?.materials ?? [];
  }

  defaultMaterial(): string {
    return this.setup()?.defaultMaterial ?? '';
  }

  fixedCount(): number {
    return this.setup()?.fixed.length ?? 0;
  }

  loadedCount(): number {
    return this.setup()?.loads.length ?? 0;
  }

  materialsInUse(): string[] {
    const setup = this.setup();
    const state = this.editor.getState(this.sessionId);
    if (!setup || !state) return [];
    const counts = new Map<string, number>();
    for (const hex of state.hexes) {
      const name = setup.hexMaterials[hex.id] ?? setup.defaultMaterial;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => `${this.labelOf(name)}: ${count}`);
  }

  labelOf(name: string): string {
    return this.materials().find(m => m.name === name)?.label ?? name;
  }

  selectedCubes(): readonly number[] {
    return this.selection.hexes(this.sessionId);
  }

  pickedFaceText(): string {
    const face = this.selection.face(this.sessionId);
    if (!face) return '';
    const parts = [`Куб ${face.hex}, ${face.face}`];
    if (this.solver.isFixed(this.sessionId, face.hex, face.face)) parts.push('закріплена');
    const pressure = this.solver.pressureOn(this.sessionId, face.hex, face.face);
    if (pressure !== null) parts.push(`тиск ${pressure / MPA} МПа`);
    return parts.join(' · ');
  }

  hasPickedFace(): boolean {
    return this.selection.face(this.sessionId) !== null;
  }

  // --- commands ---

  onDefaultMaterial(event: Event): void {
    this.solver.setDefaultMaterial(this.sessionId, (event.target as HTMLSelectElement).value);
  }

  onMaterialOfSelection(event: Event): void {
    const select = event.target as HTMLSelectElement;
    if (select.value) this.solver.setMaterialOfSelection(this.sessionId, select.value);
    select.value = '';
  }

  fixPicked(fixed: boolean): void {
    this.solver.fixPickedFace(this.sessionId, fixed);
  }

  loadPicked(apply: boolean): void {
    this.solver.loadPickedFace(this.sessionId, apply ? this.pressureMPa * MPA : null);
  }

  onSide(event: Event): void {
    this.side = (event.target as HTMLSelectElement).value as HexFaceName;
  }

  onPressure(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.pressureMPa = value;
  }

  fixSide(fixed: boolean): void {
    this.solver.fixSide(this.sessionId, this.side, fixed);
  }

  loadSide(apply: boolean): void {
    this.solver.loadSide(this.sessionId, this.side, apply ? this.pressureMPa * MPA : null);
  }

  clearSetup(): void {
    this.solver.clearSetup(this.sessionId);
  }

  canAddMaterial(): boolean {
    return this.newLabel.trim().length > 0 && this.newYoungGPa > 0 && this.newPoisson >= 0 && this.newPoisson < 0.5;
  }

  addMaterial(): void {
    if (!this.canAddMaterial()) return;
    const label = this.newLabel.trim();
    const name = `custom-${label.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/gi, '-')}`;
    this.solver.upsertMaterial(this.sessionId, { name, label, e: this.newYoungGPa * GPA, nu: this.newPoisson });
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

  // --- solving ---

  validate(): void {
    this.solver.validate(this.sessionId);
  }

  solve(): void {
    void this.solver.solve(this.sessionId);
  }

  cancel(): void {
    this.solver.cancel(this.sessionId);
  }

  isRunning(): boolean {
    return this.solver.isRunning(this.sessionId);
  }

  validation() {
    return this.solver.validation(this.sessionId);
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

  // --- the solution ---

  result() {
    return this.solver.result(this.sessionId);
  }

  display() {
    return this.solver.display(this.sessionId);
  }

  onField(event: Event): void {
    this.solver.setField(this.sessionId, (event.target as HTMLSelectElement).value as ResultField);
  }

  onScale(event: Event): void {
    this.numberField(event, value => this.solver.setDeformationScale(this.sessionId, value));
  }

  clearResult(): void {
    this.solver.clearResult(this.sessionId);
  }

  maxText(): string {
    const result = this.result();
    if (!result) return '';
    return `макс. напруження ${(result.maxVonMises / MPA).toPrecision(4)} МПа · макс. переміщення ${result.maxDisplacement.toExponential(3)}`;
  }

  // The values at the two ends of the colour bar, and the bar itself as a CSS gradient.
  legend(): { min: string; max: string; gradient: string } | null {
    const result = this.result();
    const field = this.display().field;
    if (!result || field === 'none') return null;
    const values = fieldValues(result, field);
    if (!values) return null;
    const max = fieldRange(values).max;
    const stops = [0, 0.25, 0.5, 0.75, 1].map(t => `#${rampColor(t).getHexString()} ${t * 100}%`);
    return {
      min: '0',
      max: field === 'vonMises' ? `${(max / MPA).toPrecision(4)} МПа` : max.toExponential(3),
      gradient: `linear-gradient(to right, ${stops.join(', ')})`
    };
  }

  elapsedText(): string {
    const result = this.result();
    return result ? `${result.elapsedSeconds.toFixed(2)} с` : '';
  }
}
