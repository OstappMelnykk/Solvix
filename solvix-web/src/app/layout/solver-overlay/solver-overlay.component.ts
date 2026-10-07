import { Component, Input, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { Scope, Tool } from '../../geometry/solver-targets';
import { ResultField, SolverService } from '../../state/solver.service';
import { fieldRange, fieldValues, materialColor, rampColor } from '../../geometry/solver-view';
import { SolverMaterialDto } from '../../api/solver-api.service';

const MAX_SCALE = 500000;
const MPA = 1e6;

export const TOOLS: readonly { tool: Tool; label: string; title: string }[] = [
  { tool: 'view', label: 'Огляд', title: 'Лише дивитися й обертати: клік нічого не змінює' },
  { tool: 'load', label: 'Тиск', title: 'Клік позначає грані як навантажені (зелені); ще клік — знімає' },
  { tool: 'fix', label: 'Опора', title: 'Клік закріплює грані (сині); ще клік — знімає' },
  { tool: 'material', label: 'Матеріал', title: 'Клік фарбує елементи вибраним матеріалом' }
];

const SCOPE_LABELS: Record<Scope, { label: string; title: string }> = {
  cell: { label: 'Один', title: 'Лише той елемент або грань, на яку навели' },
  column: { label: 'Стовпчик', title: 'Усі елементи під гранню, від поверхні вглиб куба' },
  layer: { label: 'Шар', title: 'Увесь шар куба на вибраній глибині, паралельний грані' },
  cube: { label: 'Куб', title: 'Увесь куб (або вся його грань)' },
  side: { label: 'Сторона', title: 'Усі зовнішні грані з такою самою назвою' }
};

// The controls drawn over the Solver World's canvas: what a click does (the tool), how far it reaches, the material
// to paint with, how see-through the cubes are, the deformation of a result, the legend and the colour scale.
@Component({
  selector: 'app-solver-overlay',
  standalone: true,
  imports: [NgIf, NgFor],
  templateUrl: './solver-overlay.component.html',
  styleUrl: './solver-overlay.component.scss'
})
export class SolverOverlayComponent {
  private readonly solver = inject(SolverService);

  @Input({ required: true }) sessionId!: number;

  readonly tools = TOOLS;
  readonly opacityPresets = [100, 70, 40, 15];

  // The list of scopes is built afresh on every change detection; tracking by scope keeps the buttons themselves.
  trackScope(_: number, item: { scope: Scope }): Scope {
    return item.scope;
  }

  // --- the tool ---

  tool(): Tool {
    return this.solver.tool(this.sessionId);
  }

  setTool(tool: Tool): void {
    this.solver.setTool(this.sessionId, tool);
  }

  scopes(): { scope: Scope; label: string; title: string }[] {
    return this.solver.scopesOf(this.tool()).map(scope => ({ scope, ...SCOPE_LABELS[scope] }));
  }

  scope(): Scope {
    return this.solver.scope(this.sessionId);
  }

  setScope(scope: Scope): void {
    this.solver.setScope(this.sessionId, scope);
  }

  // The depth only means something for the material tool, and only when a cube is cut along the axis.
  hasDepth(): boolean {
    return this.tool() === 'material' && (this.scope() === 'cell' || this.scope() === 'layer') && Math.max(...this.solver.divisions(this.sessionId)) > 1;
  }

  depth(): number {
    return this.solver.depth(this.sessionId);
  }

  deeper(step: number): void {
    this.solver.setDepth(this.sessionId, this.depth() + step);
  }

  // --- the material to paint with ---

  isMaterialTool(): boolean {
    return this.tool() === 'material';
  }

  materials(): readonly SolverMaterialDto[] {
    return this.solver.setup(this.sessionId)?.materials ?? [];
  }

  activeMaterial(): string {
    return this.solver.activeMaterial(this.sessionId);
  }

  setActiveMaterial(name: string): void {
    this.solver.setActiveMaterial(this.sessionId, name);
  }

  colorOf(name: string): string {
    return `#${materialColor(name).getHexString()}`;
  }

  // --- the hint under the cursor ---

  hint(): string {
    switch (this.tool()) {
      case 'load':
        return 'Клік по зовнішній грані — навантажити (Pn з панелі) або зняти.';
      case 'fix':
        return 'Клік по зовнішній грані — закріпити або зняти.';
      case 'material':
        return 'Клік — пофарбувати вибраним матеріалом. Глибина вибирає елемент під гранню.';
      default:
        return 'Оберіть інструмент, щоб задавати тиск, опори й матеріали.';
    }
  }

  // --- legend of the marked faces ---

  loadedText(): string {
    return `${this.solver.loadedFaceCount(this.sessionId)} граней СЕ`;
  }

  fixedText(): string {
    const count = this.solver.fixedFaceCount(this.sessionId);
    return this.solver.isFixedAuto(this.sessionId) ? `${count} граней СЕ (авто)` : `${count} граней СЕ`;
  }

  // --- see-through and the inner faces ---

  opacityPercent(): number {
    return Math.round(this.solver.display(this.sessionId).opacity * 100);
  }

  onOpacity(event: Event): void {
    const percent = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(percent)) this.solver.setOpacity(this.sessionId, percent / 100);
  }

  setOpacityPercent(percent: number): void {
    this.solver.setOpacity(this.sessionId, percent / 100);
  }

  showInner(): boolean {
    return this.solver.showInner(this.sessionId);
  }

  toggleInner(): void {
    this.solver.setShowInner(this.sessionId, !this.showInner());
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
