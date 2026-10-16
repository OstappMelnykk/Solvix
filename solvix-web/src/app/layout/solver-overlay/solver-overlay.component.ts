import { Component, Input, inject } from '@angular/core';
import { DecimalPipe, NgFor, NgIf } from '@angular/common';
import { Scope, Tool } from '../../geometry/solver-targets';
import { ResultField, SolverService } from '../../state/solver.service';
import { fieldRange, fieldValues, materialColor, pressureColor, rampColor } from '../../geometry/solver-view';
import { SolverMaterialDto } from '../../api/solver-api.service';
import { UndoRedoService } from '../../state/undo-redo.service';
import { NotificationService } from '../../state/notification.service';

const SLIDER_STEPS = 1000;
const MPA = 1e6;
const MAX_PRESSURE_MPA = 1e4;

export const TOOLS: readonly { tool: Tool; label: string; title: string }[] = [
  { tool: 'view', label: 'Огляд', title: 'Лише дивитися й обертати: клік нічого не змінює' },
  { tool: 'load', label: 'Тиск', title: 'Клік позначає грані як навантажені (зелені); ще клік — знімає' },
  { tool: 'fix', label: 'Опора', title: 'Клік закріплює грані (сині); ще клік — знімає' },
  { tool: 'erase', label: 'Гумка', title: 'Стирає і тиск, і опору з граней, до яких торкнулись' },
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
  imports: [NgIf, NgFor, DecimalPipe],
  templateUrl: './solver-overlay.component.html',
  styleUrl: './solver-overlay.component.scss'
})
export class SolverOverlayComponent {
  private readonly solver = inject(SolverService);
  private readonly notifications = inject(NotificationService);
  private readonly undoRedo = inject(UndoRedoService);

  @Input({ required: true }) sessionId!: number;

  readonly tools = TOOLS;

  // The two windows can be folded to their title and a tick.
  private readonly closed = new Set<'tools' | 'view'>();

  open(box: 'tools' | 'view'): boolean {
    return !this.closed.has(box);
  }

  toggleOpen(box: 'tools' | 'view'): void {
    if (!this.closed.delete(box)) this.closed.add(box);
  }

  // --- the brush ---

  // The tools that can paint: Pressure, Support and Material.
  isFaceTool(): boolean {
    return this.tool() !== 'view';
  }

  brush(): boolean {
    return this.solver.brush(this.sessionId);
  }

  toggleBrush(): void {
    this.solver.setBrush(this.sessionId, !this.brush());
  }

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
    return this.solver.scopesOf(this.tool(), this.sessionId).map(scope => ({ scope, ...SCOPE_LABELS[scope] }));
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

  // --- the pressure the next faces get ---

  pressureMpa(): number {
    return this.solver.pressure(this.sessionId) / MPA;
  }

  onPressureMpa(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    // steel is some 200 000 MPa: a pressure beyond 10 000 MPa is a slip (Pa typed into the MPa box)
    if (Math.abs(value) > MAX_PRESSURE_MPA) {
      this.notifications.warning(`Тиск ${value} МПа нереальний: поле у МПа (1 МПа = 1 000 000 Па). Для 1 МПа введіть 1.`);
      return;
    }
    this.solver.setPressure(this.sessionId, value * MPA);
  }

  // --- legend of the marked faces ---

  // One line per different pressure with its colour in the scene.
  pressureKey(): { color: string; text: string }[] {
    const groups = this.solver.loadedPressures(this.sessionId);
    const all = groups.map(g => g.pressure);
    return groups.map(g => ({ color: `#${pressureColor(all, g.pressure).toString(16).padStart(6, '0')}`, text: `${(g.pressure / MPA).toPrecision(3)} МПа · ${g.count}` }));
  }

  loadedText(): string {
    const count = this.solver.loadedFaceCount(this.sessionId);
    const groups = this.solver.loadedPressures(this.sessionId);
    if (groups.length <= 1) return `${count} граней СЕ`;
    return groups.map(g => `${g.count} × ${(g.pressure / MPA).toPrecision(3)} МПа`).join(', ');
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

  // Taking back the last action of the set-up, whatever it was (also Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z everywhere in the app).
  canUndo(): boolean {
    return this.undoRedo.canUndo();
  }

  canRedo(): boolean {
    return this.undoRedo.canRedo();
  }

  undo(): void {
    this.undoRedo.undo();
  }

  redo(): void {
    this.undoRedo.redo();
  }

  showInner(): boolean {
    return this.solver.showInner(this.sessionId);
  }

  toggleInner(): void {
    this.solver.setShowInner(this.sessionId, !this.showInner());
  }

  // --- deformation: the solver's number box plus a slider; the slider is cubic so that small factors stay reachable ---

  showMark(kind: 'fixed' | 'loads'): boolean {
    return this.solver.marks(this.sessionId, 'solver')[kind];
  }

  toggleMark(kind: 'fixed' | 'loads'): void {
    this.solver.setMarks(this.sessionId, 'solver', kind, !this.showMark(kind));
  }

  showVectors(): boolean {
    return this.solver.display(this.sessionId).vectors;
  }

  toggleVectors(): void {
    this.solver.setVectors(this.sessionId, !this.showVectors());
  }

  openViewer(): void {
    this.solver.setViewer(this.sessionId, true);
  }

  readonly unreliableText = SolverService.UNRELIABLE;

  unreliable(): boolean {
    const result = this.solver.result(this.sessionId);
    return result !== null && SolverService.isUnreliable(result);
  }

  hasResult(): boolean {
    return this.solver.result(this.sessionId) !== null;
  }

  scale(): number {
    return this.solver.display(this.sessionId).deformationScale;
  }

  // The top of the range: the factor at which the largest displacement is a quarter of the body's size - far enough to
  // follow how the body bends, short of the absurd shapes a larger factor makes. Neither box nor slider goes past it.
  top(): number {
    const result = this.solver.result(this.sessionId);
    return Math.max(1, result ? SolverService.maxScale(result) : 1);
  }

  readonly sliderSteps = SLIDER_STEPS;

  scaleSlider(): number {
    return Math.round((SLIDER_STEPS * Math.min(this.scale(), this.top())) / this.top());
  }

  onScaleNumber(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value >= 0) this.solver.setDeformationScale(this.sessionId, Math.min(value, this.top()));
  }

  onScaleSlider(event: Event): void {
    const position = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(position)) this.solver.setDeformationScale(this.sessionId, (Math.min(Math.max(position, 0), SLIDER_STEPS) / SLIDER_STEPS) * this.top());
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
