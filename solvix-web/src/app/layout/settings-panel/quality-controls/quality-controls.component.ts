import { DoCheck, Component, Input, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { SolverElementProfileDto, SolverQualityDto, SolverQualityLimitDto, SolverQualityReportDto } from '../../../api/solver-api.service';
import { SOLVER_WORLD_INDEX } from '../../../config/app-settings';
import { RESULT_COLORS } from '../../../geometry/solver-view';
import {
  CONSENSUS_ID, DecisionLevel, QualityDecision, QualityMetric, RESULT_NAMES, Result, anglesText, buildConsensus, decide, isRejected, metricGrade, resultOf,
  ruleText
} from '../../../geometry/quality-grading';
import { ActiveWorldService } from '../../../state/active-world.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { QualityPick, SolverService } from '../../../state/solver.service';

interface CriterionRow {
  readonly limit: SolverQualityLimitDto;
  readonly value: number;
  readonly shown: string;
  readonly ok: boolean;
}

interface StandardRow {
  readonly id: string;
  readonly name: string;
  readonly percent: number;
  readonly state: 'ok' | 'some';
  readonly dto: SolverQualityDto;
}

// The Quality World's wide window. It answers, top to bottom: can the solver be used, by which standard to judge, what
// the scene shows, how the whole mesh does, and - after a click on the scene - everything about the clicked element.
@Component({
  selector: 'app-quality-controls',
  standalone: true,
  imports: [NgIf, NgFor],
  templateUrl: './quality-controls.component.html',
  styleUrl: './quality-controls.component.scss'
})
export class QualityControlsComponent implements DoCheck {
  private readonly solver = inject(SolverService);
  private readonly editor = inject(MeshEditorService);
  private readonly activeWorld = inject(ActiveWorldService);

  @Input({ required: true }) sessionId!: number;

  readonly consensusId = CONSENSUS_ID;
  readonly resultNames = RESULT_NAMES;

  // The quality follows the mesh: it is asked again whenever the mesh or the division changed.
  ngDoCheck(): void {
    this.solver.ensureQuality(this.sessionId);
  }

  quality() {
    return this.solver.quality(this.sessionId);
  }

  report() {
    return this.solver.qualityReport(this.sessionId);
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

  trackKey(_: number, item: { limit: { key: string } } | { key: string }): string {
    return 'limit' in item ? item.limit.key : item.key;
  }

  trackIndex(index: number): number {
    return index;
  }

  color(result: Result): string {
    return `#${RESULT_COLORS[result].toString(16).padStart(6, '0')}`;
  }

  // --- 1. can the solver be used ---

  private decisionOf: { report: unknown; value: QualityDecision } | null = null;

  decision(): QualityDecision | null {
    const report = this.report();
    if (!report) return null;
    if (this.decisionOf?.report !== report) this.decisionOf = { report, value: decide(report) };
    return this.decisionOf.value;
  }

  // The button to the solver is always there: it is the user who decides to go on. It only says what to expect.
  goLabel(level: DecisionLevel): string {
    return level === 'ok' ? 'Перейти до розрахунку' : level === 'caution' ? 'Перейти до розрахунку' : level === 'bad' ? 'Все одно перейти до розрахунку' : 'Перейти до розрахунку (не запуститься)';
  }

  goToSolver(): void {
    this.activeWorld.selectCurrentWorld(SOLVER_WORLD_INDEX);
  }

  decisionIcon(level: DecisionLevel): string {
    return level === 'ok' ? '✓' : level === 'caution' ? '!' : '✗';
  }

  // --- 2. by which standard ---

  profile(): string {
    return this.solver.qualityProfile(this.sessionId);
  }

  setProfile(id: string): void {
    this.solver.setQualityProfile(this.sessionId, id);
  }

  private consensusOf: { report: SolverQualityReportDto; dto: SolverQualityDto } | null = null;

  private consensus(report: SolverQualityReportDto): SolverQualityDto {
    if (this.consensusOf?.report !== report) this.consensusOf = { report, dto: buildConsensus(report) };
    return this.consensusOf.dto;
  }

  // The overall result first, then each standard, with the share of elements it accepts.
  standards(): StandardRow[] {
    const report = this.report();
    if (!report) return [];
    return [this.consensus(report), ...report.profiles].map(dto => {
      const rejected = dto.grades.poor + dto.grades.invalid;
      const percent = dto.elements > 0 ? ((dto.elements - rejected) / dto.elements) * 100 : 100;
      return { id: dto.id, name: dto.name, percent, state: rejected === 0 ? 'ok' : 'some', dto };
    });
  }

  percentText(percent: number): string {
    return percent >= 100 ? '100%' : percent > 99 ? '>99%' : `${Math.round(percent)}%`;
  }

  // --- 3. what the scene shows ---

  metric(): QualityMetric {
    return this.solver.qualityMetric(this.sessionId);
  }

  setMetric(metric: QualityMetric): void {
    this.solver.setQualityMetric(this.sessionId, metric);
  }

  overall(): boolean {
    return this.quality()?.id === CONSENSUS_ID;
  }

  // The colours the scene uses in this mode, with their meaning.
  legend(): { result: Result; text: string }[] {
    const q = this.quality();
    if (!q) return [];
    return q.id === CONSENSUS_ID
      ? [
          { result: 'accepted', text: 'Приймається всіма стандартами' },
          { result: 'disputed', text: 'Спірно: один-два стандарти не приймають' },
          { result: 'rejected', text: 'Не приймається: три й більше стандартів' }
        ]
      : [
          { result: 'accepted', text: `Приймається за ${q.name}` },
          { result: 'rejected', text: `Не приймається за ${q.name}` }
        ];
  }

  // --- 4. the whole mesh by the chosen standard ---

  private rowOf(limit: SolverQualityLimitDto, value: number, source: Readonly<Record<string, number>>): CriterionRow {
    const shown = limit.kind === 'angleDeviation' ? anglesText(source['minAngle'], source['maxAngle']) : `${value.toFixed(limit.decimals)}${limit.unit}`;
    return { limit, value, shown, ok: !isRejected(metricGrade(limit, value)) };
  }

  meshRows(): CriterionRow[] {
    const q = this.quality();
    if (!q) return [];
    return q.limits.map(limit => this.rowOf(limit, q.worst[limit.key], q.worst));
  }

  rejectedCount(): number {
    const q = this.quality();
    return q ? q.grades.poor + q.grades.invalid : 0;
  }

  // Takes the user to the worst element for a measure, on the scene and in the details.
  showWorst(limit: SolverQualityLimitDto): void {
    const q = this.quality();
    if (!q) return;
    const target = this.solver.qualityReport(this.sessionId)?.profiles.find(p => p.id === q.id) ?? q;
    const sign = limit.higherIsBetter ? 1 : -1;
    const worst = target.flagged.reduce<typeof target.flagged[number] | null>((best, f) => (best === null || sign * f.values[limit.key] < sign * best.values[limit.key] ? f : best), null);
    if (worst) this.solver.setQualityPick(this.sessionId, { hex: worst.hex, ex: worst.ex, ey: worst.ey, ez: worst.ez });
  }

  // --- 5. the picked element ---

  pick(): QualityPick | null {
    return this.solver.qualityPick(this.sessionId);
  }

  clearPick(): void {
    const pick = this.pick();
    if (pick) this.solver.setQualityPick(this.sessionId, pick);          // picking again clears it
  }

  placeText(pick: QualityPick): string {
    return this.solver.divisions(this.sessionId).some(n => n > 1) ? `Куб ${pick.hex}, елемент (${pick.ex}, ${pick.ey}, ${pick.ez})` : `Куб ${pick.hex}`;
  }

  // In the picked cube: how many small elements the chosen standard rejects.
  cubeText(pick: QualityPick): string {
    const q = this.quality();
    if (!q || !this.solver.divisions(this.sessionId).some(n => n > 1)) return '';
    const per = this.solver.divisions(this.sessionId).reduce((a, b) => a * b, 1);
    const rejected = q.flagged.filter(f => f.hex === pick.hex && isRejected(f.grade)).length;
    return rejected === 0 ? `У цьому кубі всі ${per} елементів приймаються.` : `У цьому кубі ${rejected} із ${per} елементів не приймаються.`;
  }

  private detailOf(id: string): SolverElementProfileDto | undefined {
    return this.solver.qualityDetail(this.sessionId)?.profiles.find(p => p.id === id);
  }

  hasDetail(): boolean {
    return this.solver.qualityDetail(this.sessionId) !== null;
  }

  // How every standard judges the picked element, and the overall result.
  verdicts(): { id: string; name: string; result: Result }[] {
    const detail = this.solver.qualityDetail(this.sessionId);
    const report = this.report();
    if (!detail || !report) return [];
    const rows = detail.profiles.map(p => ({ id: p.id, name: report.profiles.find(x => x.id === p.id)?.name ?? p.id, result: resultOf(p.grade, false) }));
    const rejecting = rows.filter(r => r.result === 'rejected').length;
    const overall: Result = rejecting === 0 ? 'accepted' : rejecting >= 3 ? 'rejected' : 'disputed';
    return [{ id: CONSENSUS_ID, name: 'Загальний результат', result: overall }, ...rows];
  }

  // The standard whose measures are listed: the chosen one (with the overall result chosen, every standard that rejects).
  detailStandard(): SolverQualityDto | null {
    const q = this.quality();
    return q && q.id !== CONSENSUS_ID ? q : null;
  }

  // The picked element's value of every measure of the chosen standard.
  detailRows(): CriterionRow[] {
    const standard = this.detailStandard();
    const detail = standard ? this.detailOf(standard.id) : undefined;
    return standard && detail ? standard.limits.map(limit => this.rowOf(limit, detail.values[limit.key], detail.values)) : [];
  }

  // For the overall result: every measure of every standard that the picked element fails, with the standard's name.
  failures(): { standard: string; row: CriterionRow }[] {
    const report = this.report();
    const detail = this.solver.qualityDetail(this.sessionId);
    if (!report || !detail) return [];
    return report.profiles.flatMap(profile => {
      const one = detail.profiles.find(p => p.id === profile.id);
      return one ? profile.limits.map(limit => ({ standard: profile.name, row: this.rowOf(limit, one.values[limit.key], one.values) })).filter(f => !f.row.ok) : [];
    });
  }

  limitText(limit: SolverQualityLimitDto): string {
    return ruleText(limit);
  }
}
