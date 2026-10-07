import { Component, Input, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import { PickMode, ResultField, SolverService } from '../../state/solver.service';
import { fieldRange, fieldValues, rampColor } from '../../geometry/solver-view';

const MAX_SCALE = 500000;
const MPA = 1e6;

// The controls drawn over the Solver World's canvas, as in the solver's own viewer: what a click on a face does
// (Load / Fix), the deformation slider, the see-through slider, the legend of the marked faces and the colour scale.
@Component({
  selector: 'app-solver-overlay',
  standalone: true,
  imports: [NgIf],
  templateUrl: './solver-overlay.component.html',
  styleUrl: './solver-overlay.component.scss'
})
export class SolverOverlayComponent {
  private readonly solver = inject(SolverService);

  @Input({ required: true }) sessionId!: number;

  mode(): PickMode {
    return this.solver.mode(this.sessionId);
  }

  setMode(mode: PickMode): void {
    this.solver.setMode(this.sessionId, mode);
  }

  // --- legend of the marked faces ---

  loadedText(): string {
    return `${this.solver.loadedFaceCount(this.sessionId)} граней СЕ`;
  }

  fixedText(): string {
    const count = this.solver.fixedFaceCount(this.sessionId);
    return this.solver.isFixedAuto(this.sessionId) ? `${count} граней СЕ (авто)` : `${count} граней СЕ`;
  }

  // --- deformation: the solver's number box plus a slider; the slider is cubic so that small factors stay reachable ---

  hasResult(): boolean {
    return this.solver.result(this.sessionId) !== null;
  }

  scale(): number {
    return this.solver.display(this.sessionId).deformationScale;
  }

  scaleSlider(): number {
    return Math.round(100 * Math.cbrt(Math.min(this.scale(), MAX_SCALE) / MAX_SCALE));
  }

  onScaleNumber(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.solver.setDeformationScale(this.sessionId, Math.min(value, MAX_SCALE));
  }

  onScaleSlider(event: Event): void {
    const position = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(position)) this.solver.setDeformationScale(this.sessionId, Math.round(MAX_SCALE * Math.pow(position / 100, 3)));
  }

  shownText(): string {
    const result = this.solver.result(this.sessionId);
    if (!result) return '';
    return `Показано: ${(result.maxDisplacement * this.scale()).toExponential(2)} (реально: ${result.maxDisplacement.toExponential(2)})`;
  }

  // --- see-through ---

  opacityPercent(): number {
    return Math.round(this.solver.display(this.sessionId).opacity * 100);
  }

  onOpacity(event: Event): void {
    const percent = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(percent)) this.solver.setOpacity(this.sessionId, percent / 100);
  }

  // --- the colour scale ---

  field(): ResultField {
    return this.solver.display(this.sessionId).field;
  }

  legend(): { max: string; min: string; gradient: string; label: string } | null {
    const result = this.solver.result(this.sessionId);
    const field = this.field();
    if (!result || field === 'none') return null;
    const values = fieldValues(result, field);
    if (!values) return null;
    const range = fieldRange(values);
    const text = (v: number) => (field === 'vonMises' ? `${(v / MPA).toPrecision(4)} МПа` : v.toExponential(2));
    const stops = [1, 0.75, 0.5, 0.25, 0].map(t => `#${rampColor(t).getHexString()} ${(1 - t) * 100}%`);
    return {
      max: text(range.max),
      min: text(0),
      gradient: `linear-gradient(to bottom, ${stops.join(', ')})`,
      label: field === 'vonMises' ? 'Von Mises' : 'Переміщення'
    };
  }
}
