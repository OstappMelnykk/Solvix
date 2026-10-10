import { Component, HostListener, Input, OnDestroy, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { SolverMaterialDto } from '../../api/solver-api.service';
import { fieldRange, fieldValues, materialColor, rampColor } from '../../geometry/solver-view';
import { ResultField, SolverService } from '../../state/solver.service';

const MPA = 1e6;
const SLIDER_STEPS = 10000;
// A sweep from no deformation to the top takes this long at speed 1.
const SWEEP_SECONDS = 6;

type PlayMode = 'loop' | 'bounce' | 'once';

// The full-window result viewer: everything but the body and the tools for looking at the result is gone. The player
// runs the deformation from nothing to the top of its range (a sweep that is physically honest at the right end),
// the colour scale can be capped so one hot spot does not wash out the rest, and "×1" returns to the real result
// however invisible it is. The view is moved in place (see SolverRenderService), so scrubbing and playing cost one
// pass over the vertex buffers per frame.
@Component({
  selector: 'app-solver-viewer',
  standalone: true,
  imports: [NgIf, NgFor],
  templateUrl: './solver-viewer.component.html',
  styleUrl: './solver-viewer.component.scss'
})
export class SolverViewerComponent implements OnDestroy {
  private readonly solver = inject(SolverService);

  @Input({ required: true }) sessionId!: number;

  readonly speeds = [0.25, 0.5, 1, 2, 4];
  readonly modes: readonly { mode: PlayMode; label: string; title: string }[] = [
    { mode: 'loop', label: '⟲', title: 'По колу: 0 → максимум, знову з нуля' },
    { mode: 'bounce', label: '⇄', title: 'Туди й назад' },
    { mode: 'once', label: '→', title: 'Один раз до кінця' }
  ];
  playing = false;
  mode: PlayMode = 'bounce';
  speed = 1;
  private direction: 1 | -1 = 1;
  private frame = 0;
  private lastTime = 0;

  ngOnDestroy(): void {
    this.pause();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if ((event.target as HTMLElement | null)?.tagName === 'INPUT' || (event.target as HTMLElement | null)?.tagName === 'SELECT') return;
    if (event.key === 'Escape') this.exit();
    else if (event.key === ' ') {
      event.preventDefault();
      this.togglePlay();
    }
  }

  exit(): void {
    this.pause();
    this.solver.setViewer(this.sessionId, false);
  }

  // --- the deformation: slider, player, real value ---

  result() {
    return this.solver.result(this.sessionId);
  }

  scale(): number {
    return this.solver.display(this.sessionId).deformationScale;
  }

  top(): number {
    const result = this.result();
    return result ? SolverService.maxScale(result) : 1;
  }

  position(): number {
    return Math.round((SLIDER_STEPS * Math.min(this.scale(), this.top())) / this.top());
  }

  steps = SLIDER_STEPS;

  onSlider(event: Event): void {
    this.pause();
    const position = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(position)) this.solver.setDeformationScale(this.sessionId, (position / SLIDER_STEPS) * this.top());
  }

  onScaleNumber(event: Event): void {
    this.pause();
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value >= 0) this.solver.setDeformationScale(this.sessionId, Math.min(value, 500000));
  }

  // The result as it is, however small: the factor 1.
  real(): void {
    this.pause();
    this.solver.setDeformationScale(this.sessionId, 1);
  }

  isReal(): boolean {
    return this.scale() === 1;
  }

  // The largest displacement drawn at the current factor, with a unit that fits (the model is in metres).
  shownText(): string {
    const result = this.result();
    return result ? `${length(result.maxDisplacement * this.scale())} (реально ${length(result.maxDisplacement)})` : '';
  }

  topText(): string {
    const result = this.result();
    return result ? length(result.maxDisplacement * this.top()) : '';
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing) return;
    if (this.scale() >= this.top()) this.solver.setDeformationScale(this.sessionId, 0);
    this.playing = true;
    this.direction = 1;
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.frame);
  }

  private tick = (now: number): void => {
    if (!this.playing) return;
    const top = this.top();
    const step = (((now - this.lastTime) / 1000) * this.speed * top) / SWEEP_SECONDS;
    this.lastTime = now;
    let value = this.scale() + this.direction * step;
    if (value >= top) {
      if (this.mode === 'once') {
        value = top;
        this.playing = false;
      } else if (this.mode === 'bounce') {
        value = top;
        this.direction = -1;
      } else value = 0;
    } else if (value <= 0) {
      value = 0;
      this.direction = 1;
    }
    this.solver.setDeformationScale(this.sessionId, value);
    if (this.playing) this.frame = requestAnimationFrame(this.tick);
  };

  // --- the field and its colour scale ---

  field(): ResultField {
    return this.solver.display(this.sessionId).field;
  }

  onField(event: Event): void {
    this.solver.setField(this.sessionId, (event.target as HTMLSelectElement).value as ResultField);
  }

  private values(): number[] | null {
    const result = this.result();
    return result && this.field() !== 'none' ? fieldValues(result, this.field()) : null;
  }

  private unit(): number {
    return this.field() === 'vonMises' ? MPA : 1;
  }

  fullMax(): number {
    const values = this.values();
    return values ? fieldRange(values).max : 0;
  }

  colorMax(): number {
    return this.solver.display(this.sessionId).colorMax ?? this.fullMax();
  }

  isCapped(): boolean {
    return this.solver.display(this.sessionId).colorMax !== null;
  }

  maxText(): string {
    return this.format(this.colorMax());
  }

  maxInput(): string {
    return (this.colorMax() / this.unit()).toPrecision(4);
  }

  unitText(): string {
    return this.field() === 'vonMises' ? 'МПа' : 'м';
  }

  private format(value: number): string {
    return this.field() === 'vonMises' ? `${(value / MPA).toPrecision(4)} МПа` : value.toExponential(2);
  }

  onMaxInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value) * this.unit();
    if (Number.isFinite(value) && value > 0) this.solver.setColorMax(this.sessionId, Math.min(value, this.fullMax()));
  }

  // Caps the scale at a percentile of the nodal values: the top few points (often a singularity at a corner or a
  // support) stop deciding the colours.
  capAt(percentile: number): void {
    const values = this.values();
    if (!values || values.length === 0) return;
    if (percentile >= 100) return this.solver.setColorMax(this.sessionId, null);
    const sorted = Float64Array.from(values).sort();
    this.solver.setColorMax(this.sessionId, sorted[Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length))] || null);
  }

  gradient(): string {
    return `linear-gradient(to top, ${[0, 0.25, 0.5, 0.75, 1].map(t => `#${rampColor(t).getHexString()} ${t * 100}%`).join(', ')})`;
  }

  tick25(): string[] {
    return [1, 0.75, 0.5, 0.25, 0].map(t => this.format(t * this.colorMax()));
  }

  // --- the look ---

  opacityPercent(): number {
    return Math.round(this.solver.display(this.sessionId).opacity * 100);
  }

  onOpacity(event: Event): void {
    const percent = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(percent)) this.solver.setOpacity(this.sessionId, percent / 100);
  }

  showInner(): boolean {
    return this.solver.showInner(this.sessionId);
  }

  toggleInner(): void {
    this.solver.setShowInner(this.sessionId, !this.showInner());
  }

  showMarks(): boolean {
    return this.solver.viewerMarks(this.sessionId);
  }

  toggleMarks(): void {
    this.solver.setViewerMarks(this.sessionId, !this.showMarks());
  }

  showEdges(): boolean {
    return this.solver.display(this.sessionId).edges;
  }

  toggleEdges(): void {
    this.solver.setEdges(this.sessionId, !this.showEdges());
  }

  materials(): readonly SolverMaterialDto[] {
    const used = this.solver.materialCounts(this.sessionId);
    return (this.solver.setup(this.sessionId)?.materials ?? []).filter(m => (used.get(m.name) ?? 0) > 0);
  }

  isHidden(name: string): boolean {
    return this.solver.hiddenMaterials(this.sessionId).has(name);
  }

  toggleMaterial(name: string): void {
    this.solver.toggleHidden(this.sessionId, name);
  }

  colorOf(name: string): string {
    return `#${materialColor(name).getHexString()}`;
  }
}

// A length in metres with a unit that fits: nm, µm, mm or m.
function length(metres: number): string {
  const a = Math.abs(metres);
  if (a === 0) return '0';
  if (a < 1e-6) return `${(metres * 1e9).toPrecision(3)} нм`;
  if (a < 1e-3) return `${(metres * 1e6).toPrecision(3)} мкм`;
  if (a < 1) return `${(metres * 1e3).toPrecision(3)} мм`;
  return `${metres.toPrecision(3)} м`;
}
