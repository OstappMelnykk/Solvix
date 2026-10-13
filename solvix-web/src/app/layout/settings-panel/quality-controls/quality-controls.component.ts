import { DoCheck, Component, Input, inject } from '@angular/core';
import { DecimalPipe, NgFor, NgIf, NgTemplateOutlet } from '@angular/common';
import { QualityGradeName, SolverElementQualityDto, SolverQualityDto, SolverQualityLimitDto } from '../../../api/solver-api.service';
import { SOLVER_WORLD_INDEX } from '../../../config/app-settings';
import { RESULT_COLORS } from '../../../geometry/solver-view';
import {
  DecisionLevel, QualityDecision, QualityMetric, RESULT_NAMES, Result, SOLVIX_ID, decide, gaugePosition, gaugeTicks, gaugeZones, measuredGrade, metricGrade, passes, rejectedCount, resultOf,
  ruleText
} from '../../../geometry/quality-grading';
import { ActiveWorldService } from '../../../state/active-world.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { QualityPick, SolverService, sameElement } from '../../../state/solver.service';
import { MeasureInfoComponent } from './measure-info/measure-info.component';
import { SmoothingControlsComponent } from '../smoothing-controls/smoothing-controls.component';
import { sectionOf } from '../../../state/quality-render.service';
import { ExploreSettings, QualityExploreService, SectionSettings } from '../../../state/quality-explore.service';
import { elementCentreOf } from '../../../geometry/solver-view';
import { GeometryOpacityService } from '../../../state/geometry-opacity.service';
import { QUALITY_WORLD_INDEX } from '../../../config/app-settings';

interface Measure {
  // the tool whose measure it is (aspect ratio means different things in different tools)
  readonly tool: string;
  readonly limit: SolverQualityLimitDto;
  readonly value: number;
  readonly shown: string;
  readonly ok: boolean;
}

// The Quality World's panel. Solvix has one criterion - the shape checks that ANSYS documents for the 20-node brick -
// and it alone says whether the mesh is accepted. Other tools' marks can be looked at on the scene, in a block of their
// own that decides nothing.
@Component({
  selector: 'app-quality-controls',
  standalone: true,
  imports: [NgIf, NgFor, NgTemplateOutlet, DecimalPipe, MeasureInfoComponent, SmoothingControlsComponent],
  templateUrl: './quality-controls.component.html',
  styleUrl: './quality-controls.component.scss'
})
export class QualityControlsComponent implements DoCheck {
  private readonly solver = inject(SolverService);
  private readonly editor = inject(MeshEditorService);
  private readonly activeWorld = inject(ActiveWorldService);
  private readonly geometryOpacity = inject(GeometryOpacityService);
  private readonly explore = inject(QualityExploreService);

  @Input({ required: true }) sessionId!: number;

  readonly resultNames = RESULT_NAMES;
  readonly gaugeZones = gaugeZones;
  readonly gaugeTicks = gaugeTicks;

  // --- looking inside: only the bad elements, a cut through the body, and a walk along the bad elements ---

  looking(): ExploreSettings {
    return this.explore.get(this.sessionId);
  }

  toggleOnlyBad(): void {
    this.explore.setOnlyBad(this.sessionId, !this.looking().onlyBad);
  }

  toggleSection(): void {
    this.explore.setSection(this.sessionId, { enabled: !this.looking().section.enabled });
  }

  setSectionAxis(axis: 0 | 1 | 2): void {
    this.explore.setSection(this.sessionId, { axis });
  }

  onSectionPosition(event: Event): void {
    this.explore.setSection(this.sessionId, { position: Number((event.target as HTMLInputElement).value) / 100 });
  }

  // Which side of the plane stays: the bigger values of the axis ('above') or the smaller ones ('below').
  setSectionSide(keep: 'above' | 'below'): void {
    this.explore.setSection(this.sessionId, { keep });
  }

  flipSection(): void {
    this.setSectionSide(this.looking().section.keep === 'above' ? 'below' : 'above');
  }

  // Where the plane is, in the units of the body: "X = 1.35".
  sectionText(): string {
    const state = this.editor.getState(this.sessionId);
    const cut = this.looking().section;
    if (!state || state.nodes.length === 0) return '';
    return `${this.axisNames[cut.axis].name} = ${sectionOf(state, cut).at.toFixed(2)}`;
  }

  sectionAxisName(): string {
    return this.axisNames[this.looking().section.axis].name;
  }

  readonly axisNames: readonly { axis: 0 | 1 | 2; name: string }[] = [{ axis: 0, name: 'X' }, { axis: 1, name: 'Y' }, { axis: 2, name: 'Z' }];

  private badOf: { solvix: SolverQualityDto; metric: QualityMetric; list: SolverElementQualityDto[] } | null = null;

  // The elements the chosen measure does not grade excellent, the worst first: the list the walk goes along.
  badElements(): readonly SolverElementQualityDto[] {
    const solvix = this.solvix();
    if (!solvix) return [];
    const metric = this.metric();
    if (this.badOf?.solvix !== solvix || this.badOf.metric !== metric) {
      const rank: Record<QualityGradeName, number> = { invalid: 0, poor: 1, acceptable: 2, good: 3, excellent: 4 };
      const graded = solvix.flagged
        .map(e => ({ e, grade: measuredGrade(e, metric, solvix.limits) }))
        .filter(x => x.grade !== 'excellent')
        .sort((a, b) => rank[a.grade] - rank[b.grade] || a.e.hex - b.e.hex || a.e.ex - b.e.ex || a.e.ey - b.e.ey || a.e.ez - b.e.ez);
      this.badOf = { solvix, metric, list: graded.map(x => x.e) };
    }
    return this.badOf.list;
  }

  // The place of the picked element in that list, from 1; 0 when it is not in it.
  badPosition(): number {
    const pick = this.pickedElement();
    return pick ? this.badElements().findIndex(e => sameElement(e, pick)) + 1 : 0;
  }

  // Picks the next (or previous) bad element; with the cut on, the plane moves to it, so it is cut open.
  walk(step: 1 | -1): void {
    const list = this.badElements();
    if (list.length === 0) return;
    const at = this.badPosition();
    const target = list[at === 0 ? (step === 1 ? 0 : list.length - 1) : (at - 1 + step + list.length) % list.length];
    const current = this.pickedElement();
    if (!current || !sameElement(current, target)) this.solver.setQualityPick(this.sessionId, { hex: target.hex, ex: target.ex, ey: target.ey, ez: target.ez });
    const cut = this.looking().section;
    const state = this.editor.getState(this.sessionId);
    if (cut.enabled && state) {
      const centre = elementCentreOf(state, this.solver.divisions(this.sessionId), target);
      if (centre) {
        const along = (p: { x: number; y: number; z: number }) => (cut.axis === 0 ? p.x : cut.axis === 1 ? p.y : p.z);
        const values = state.nodes.map(along);
        const low = Math.min(...values), high = Math.max(...values);
        this.explore.setSection(this.sessionId, { position: high > low ? (along(centre) - low) / (high - low) : 0.5 });
      }
    }
  }

  // How opaque the body is (percent): lower it to see the bad elements inside.
  opacityPercent(): number {
    return Math.round(this.geometryOpacity.get(this.sessionId, QUALITY_WORLD_INDEX) * 100);
  }

  onOpacity(event: Event): void {
    this.geometryOpacity.set(this.sessionId, QUALITY_WORLD_INDEX, Number((event.target as HTMLInputElement).value) / 100);
  }

  // The measure whose "i" popup is open (UI only).
  info: Measure | null = null;

  openInfo(m: Measure): void {
    this.info = m;
  }

  closeInfo(): void {
    this.info = null;
  }

  // The tools list of the block of other tools is open (UI only).
  toolsOpen = false;

  // The quality follows the mesh: it is asked again whenever the mesh or the division changed.
  ngDoCheck(): void {
    this.solver.ensureQuality(this.sessionId);
  }

  // Solvix's own judgement - what decides.
  solvix(): SolverQualityDto | null {
    return this.solver.solvixQuality(this.sessionId);
  }

  // What the scene shows now: Solvix's, or another tool's while looking at it.
  shown(): SolverQualityDto | null {
    return this.solver.quality(this.sessionId);
  }

  hexCount(): number {
    return this.editor.getState(this.sessionId)?.hexes.length ?? 0;
  }

  // The lists here are rebuilt on every change-detection pass (the 3D canvas triggers one every frame); without a
  // track function the buttons would be torn down and recreated between mouse-down and mouse-up, and a click would
  // never arrive.
  trackById(_: number, item: { id: string }): string {
    return item.id;
  }

  trackKey(_: number, item: { limit: { key: string } }): string {
    return item.limit.key;
  }

  trackLimit(_: number, limit: { key: string }): string {
    return limit.key;
  }

  trackLabel(_: number, item: { label: string }): string {
    return item.label;
  }

  trackResult(_: number, item: { result: Result }): string {
    return item.result;
  }

  color(result: Result): string {
    return `#${RESULT_COLORS[result].toString(16).padStart(6, '0')}`;
  }

  // --- 1. is the mesh accepted ---

  private decisionOf: { solvix: SolverQualityDto; value: QualityDecision } | null = null;

  decision(): QualityDecision | null {
    const solvix = this.solvix();
    if (!solvix) return null;
    if (this.decisionOf?.solvix !== solvix) this.decisionOf = { solvix, value: decide(solvix) };
    return this.decisionOf.value;
  }

  percentOf(part: number, total: number): string {
    const share = total > 0 ? (part / total) * 100 : 0;
    return share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`;
  }

  // The button to the solver is always there: it is the user who decides to go on. It only says what to expect.
  goLabel(level: DecisionLevel): string {
    return level === 'ok' ? 'Перейти до розрахунку' : level === 'bad' ? 'Все одно перейти до розрахунку' : 'Перейти до розрахунку (не запуститься)';
  }

  goToSolver(): void {
    this.activeWorld.selectCurrentWorld(SOLVER_WORLD_INDEX);
  }

  decisionIcon(level: DecisionLevel): string {
    return level === 'ok' ? '✓' : '✗';
  }

  // --- 2. the measures of the criterion ---

  private measureOf(limit: SolverQualityLimitDto, value: number, tool: string = SOLVIX_ID): Measure {
    const shown = value >= 1e6 ? '∞' : `${value.toFixed(limit.decimals)}${limit.unit}`;
    return { tool, limit, value, shown, ok: passes(limit, value) };
  }

  // The worst value of each measure over the whole mesh.
  meshMeasures(): Measure[] {
    return this.measuresOf(this.solvix());
  }

  // The same for any tool of the report: its own measures with its own limits.
  measuresOf(quality: SolverQualityDto | null): Measure[] {
    return quality ? quality.limits.map(limit => this.measureOf(limit, quality.worst[limit.key], quality.id)) : [];
  }

  limitText(limit: SolverQualityLimitDto): string {
    return ruleText(limit);
  }

  errorText(limit: SolverQualityLimitDto): string {
    return limit.errorBound === null ? '' : `Межа «помилка» ANSYS: ${limit.errorBound >= 1e6 ? '10⁶' : limit.errorBound}${limit.unit}`;
  }

  markerLeft(measure: Measure): string {
    return `${(gaugePosition(measure.limit, measure.value) * 100).toFixed(1)}%`;
  }

  resultOfMeasure(measure: Measure): Result {
    return measure.ok ? 'accepted' : 'rejected';
  }

  // --- 3. what the scene shows ---

  metric(): QualityMetric {
    return this.solver.qualityMetric(this.sessionId);
  }

  setMetric(metric: QualityMetric): void {
    this.solver.setQualityMetric(this.sessionId, metric);
  }

  // The colours the scene uses now, with their meaning.
  legend(): { result: Result; text: string }[] {
    const q = this.shown();
    if (!q) return [];
    return [
      { result: 'accepted', text: `Приймається (${q.name})` },
      { result: 'rejected', text: `Не приймається (${q.name})` }
    ];
  }

  showMark(kind: 'fixed' | 'loads'): boolean {
    return this.solver.marks(this.sessionId, 'quality')[kind];
  }

  toggleMark(kind: 'fixed' | 'loads'): void {
    this.solver.setMarks(this.sessionId, 'quality', kind, !this.showMark(kind));
  }

  // --- 4. the picked element ---

  pickedElement(): QualityPick | null {
    return this.solver.qualityPick(this.sessionId);
  }

  clearPick(): void {
    const pick = this.pickedElement();
    if (pick) this.solver.setQualityPick(this.sessionId, pick);          // picking the same element again clears it
  }

  // A cube is cut into more than one element only when the division says so.
  placeText(pick: QualityPick): string {
    return this.solver.divisions(this.sessionId).some(n => n > 1) ? `Куб ${pick.hex}, елемент (${pick.ex}, ${pick.ey}, ${pick.ez})` : `Куб ${pick.hex}`;
  }

  hasDetail(): boolean {
    return this.solver.qualityDetail(this.sessionId) !== null;
  }

  // The picked element's value of every measure of Solvix's criterion.
  elementMeasures(): Measure[] {
    const solvix = this.solvix();
    const one = this.solver.qualityDetail(this.sessionId)?.profiles.find(p => p.id === SOLVIX_ID);
    return solvix && one ? solvix.limits.map(limit => this.measureOf(limit, one.values[limit.key])) : [];
  }

  // Whether Solvix accepts the picked element.
  elementResult(): Result {
    const one = this.solver.qualityDetail(this.sessionId)?.profiles.find(p => p.id === SOLVIX_ID);
    return one ? resultOf(one.grade) : 'accepted';
  }

  // What the other tool on the scene says of the picked element (only while looking at that tool).
  otherToolResult(): Result | null {
    const id = this.solver.qualityCompare(this.sessionId);
    const one = id ? this.solver.qualityDetail(this.sessionId)?.profiles.find(p => p.id === id) : undefined;
    return one ? resultOf(one.grade) : null;
  }

  // --- 5. how other tools would mark the mesh (a look only) ---

  openTools(): void {
    this.toolsOpen = true;
  }

  closeTools(): void {
    this.toolsOpen = false;
    this.solver.setQualityCompare(this.sessionId, null);
  }

  compareId(): string | null {
    return this.solver.qualityCompare(this.sessionId);
  }

  // The other tools with the share of elements each accepts.
  tools(): { id: string; name: string; percent: number; dto: SolverQualityDto }[] {
    const report = this.solver.qualityReport(this.sessionId);
    if (!report) return [];
    return report.profiles
      .filter(p => p.id !== SOLVIX_ID)
      .map(dto => ({ id: dto.id, name: dto.name, percent: dto.elements > 0 ? ((dto.elements - rejectedCount(dto)) / dto.elements) * 100 : 100, dto }));
  }

  percentText(percent: number): string {
    return percent >= 100 ? '100%' : percent > 99 ? '>99%' : `${Math.round(percent)}%`;
  }

  chooseTool(id: string): void {
    this.solver.setQualityCompare(this.sessionId, this.compareId() === id ? null : id);
  }

  chosenTool(): SolverQualityDto | null {
    const id = this.compareId();
    return id ? (this.solver.qualityReport(this.sessionId)?.profiles.find(p => p.id === id) ?? null) : null;
  }

  // The measures to pick from while colouring by Solvix's criterion.
  metricChoices(): SolverQualityLimitDto[] {
    return this.solvix()?.limits.slice() ?? [];
  }

  // The grade of an element by the measure on the scene (for the tests of the worst element).
  gradeOnScene(element: { grade: QualityGradeName; values: Readonly<Record<string, number>> }): QualityGradeName {
    const q = this.shown();
    return q ? measuredGrade(element, this.metric(), q.limits) : element.grade;
  }

  // The result of a value for the gauge colours.
  resultOfValue(limit: SolverQualityLimitDto, value: number): Result {
    return resultOf(metricGrade(limit, value));
  }
}
