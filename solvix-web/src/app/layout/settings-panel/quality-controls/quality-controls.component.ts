import { DoCheck, Component, Input, inject } from '@angular/core';
import { DecimalPipe, NgFor, NgIf } from '@angular/common';
import { QualityGradeName, SolverElementQualityDto, SolverQualityDto, SolverQualityLimitDto, SolverQualityReportDto } from '../../../api/solver-api.service';
import { GRADE_COLORS } from '../../../geometry/solver-view';
import {
  CONSENSUS_ID, DecisionLevel, GRADE_NAMES, GRADE_ORDER, QualityDecision, QualityMetric, anglesText, buildConsensus, gaugePosition, gaugeZones, measuredGrade, metricGrade, metricValue,
  decide, passes, rejectedBy, rejectedCount, ruleText, worstAngle
} from '../../../geometry/quality-grading';
import { SOLVER_WORLD_INDEX } from '../../../config/app-settings';
import { ActiveWorldService } from '../../../state/active-world.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { QualityPick, SolverService, sameElement } from '../../../state/solver.service';

// The Quality World's panel: the mesh judged by several standards that can be switched and compared, is it good
// enough by the chosen one, which measure is the weak one, and - after a click on an element of the scene - everything about that element.
@Component({
  selector: 'app-quality-controls',
  standalone: true,
  imports: [NgIf, NgFor, DecimalPipe],
  templateUrl: './quality-controls.component.html',
  styleUrl: './quality-controls.component.scss'
})
export class QualityControlsComponent implements DoCheck {
  private readonly solver = inject(SolverService);
  private readonly editor = inject(MeshEditorService);
  private readonly activeWorld = inject(ActiveWorldService);

  @Input({ required: true }) sessionId!: number;

  readonly gradeOrder = GRADE_ORDER;
  readonly gradeNames = GRADE_NAMES;
  readonly gaugeZones = gaugeZones;
  readonly consensusId = CONSENSUS_ID;

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

  metric(): QualityMetric {
    return this.solver.qualityMetric(this.sessionId);
  }

  setMetric(metric: QualityMetric): void {
    this.solver.setQualityMetric(this.sessionId, metric);
  }

  // From the overall grade to a single measure: the first one of the standard until the user picks another.
  chooseMeasure(): void {
    const first = this.quality()?.limits[0];
    if (this.metric() === 'grade' && first) this.setMetric(first.key);
  }

  gradeColor(grade: QualityGradeName): string {
    return `#${GRADE_COLORS[grade].toString(16).padStart(6, '0')}`;
  }

  hexCount(): number {
    return this.editor.getState(this.sessionId)?.hexes.length ?? 0;
  }

  // --- can the solver be used ---

  private decisionOf: { report: unknown; value: QualityDecision } | null = null;

  decision(): QualityDecision | null {
    const report = this.report();
    if (!report) return null;
    if (this.decisionOf?.report !== report) this.decisionOf = { report, value: decide(report) };
    return this.decisionOf.value;
  }

  goToSolver(): void {
    this.activeWorld.selectCurrentWorld(SOLVER_WORLD_INDEX);
  }

  // Shows the elements the standards reject most: the consensus, coloured by the vote, with the worst element picked.
  showWorst(): void {
    this.solver.setQualityProfile(this.sessionId, CONSENSUS_ID);
    const worst = this.worstElement();
    if (worst) this.solver.setQualityPick(this.sessionId, { hex: worst.hex, ex: worst.ex, ey: worst.ey, ez: worst.ez });
  }

  decisionIcon(level: DecisionLevel): string {
    return level === 'ok' ? '✓' : level === 'caution' ? '!' : '✗';
  }

  // --- the standards, side by side ---

  profile(): string {
    return this.solver.qualityProfile(this.sessionId);
  }

  setProfile(id: string): void {
    this.solver.setQualityProfile(this.sessionId, id);
  }

  // The lists below are rebuilt on every change-detection pass (the 3D canvas triggers one every frame); without a
  // track function the buttons would be torn down and recreated between mouse-down and mouse-up, and a click would
  // never arrive.
  trackById(_: number, item: { id: string }): string {
    return item.id;
  }

  trackIndex(index: number): number {
    return index;
  }

  trackSegment(_: number, segment: { grade: QualityGradeName }): string {
    return segment.grade;
  }

  trackKey(_: number, item: { limit: { key: string } }): string {
    return item.limit.key;
  }

  overall(): boolean {
    return this.quality()?.id === CONSENSUS_ID;
  }

  trackZone(_: number, zone: { grade: QualityGradeName }): string {
    return zone.grade;
  }

  private consensusOf: { report: SolverQualityReportDto; dto: SolverQualityDto } | null = null;

  private consensus(report: SolverQualityReportDto): SolverQualityDto {
    if (this.consensusOf?.report !== report) this.consensusOf = { report, dto: buildConsensus(report) };
    return this.consensusOf.dto;
  }

  // One row per standard (and the consensus) with the share of elements it rejects.
  standards(): { id: string; name: string; rejected: number; share: number; dto: SolverQualityDto }[] {
    const report = this.report();
    if (!report) return [];
    const consensus = this.consensus(report);
    return [...report.profiles, consensus].map(dto => {
      const rejected = dto.id === CONSENSUS_ID ? dto.grades.poor + dto.grades.invalid : rejectedCount(dto);
      return { id: dto.id, name: dto.name, rejected, share: dto.elements > 0 ? rejected / dto.elements : 0, dto };
    });
  }

  barWidth(share: number): string {
    return `${Math.max(share > 0 ? 3 : 0, share * 100).toFixed(1)}%`;
  }

  percent(share: number): string {
    return share === 0 ? '0%' : share < 0.01 ? '<1%' : `${(share * 100).toFixed(0)}%`;
  }

  // --- the verdict ---

  verdictGrade(): QualityGradeName {
    const q = this.quality();
    return q ? (GRADE_ORDER.slice().reverse().find(g => q.grades[g] > 0) ?? 'excellent') : 'excellent';
  }

  verdict(): { title: string; sub: string } {
    const q = this.quality();
    if (!q) return { title: '', sub: '' };
    if (q.id === CONSENSUS_ID) {
      const n = q.grades.poor;
      return n > 0
        ? { title: 'Більшість стандартів відхиляє', sub: `${n} елементів не проходять у 3 і більше стандартах` }
        : q.flagged.length > 0
          ? { title: 'Є спірні елементи', sub: `${q.flagged.length} елементів не проходять хоча б в одному стандарті` }
          : { title: 'Усі стандарти згодні', sub: 'Жоден елемент не відхилено' };
    }
    const twoLevels = q.limits.every(l => l.levels === 2);
    if (q.grades.invalid > 0) return { title: 'Розрахунок неможливий', sub: `Вивернутих елементів: ${q.grades.invalid}` };
    if (q.grades.poor > 0) return { title: twoLevels ? 'Є елементи, що не проходять' : 'Є погані елементи', sub: `${q.grades.poor}${twoLevels ? '' : ' — напруження біля них будуть неточні'}` };
    if (q.grades.acceptable > 0) return { title: 'Сітка придатна', sub: `${q.grades.acceptable} елементів середньої якості` };
    return { title: twoLevels ? 'Усе проходить' : 'Сітка якісна', sub: twoLevels ? 'Жоден елемент не порушує меж' : 'Усі елементи добрі або відмінні' };
  }

  rule(): string {
    const q = this.quality();
    if (q?.id === CONSENSUS_ID) return 'Елемент відхилено, якщо він не проходить у цьому стандарті. Консенсус рахує, у скількох.';
    return q?.limits.every(l => l.levels === 2) ? 'Кожна міра має одну межу: проходить або ні.' : 'Допустимі: відмінні, добрі й прийнятні. Погані та невалідні — ні.';
  }

  // The bar of all elements by grade: only the grades that occur, as wide as their share.
  segments(): { grade: QualityGradeName; count: number }[] {
    const q = this.quality();
    return q ? GRADE_ORDER.map(grade => ({ grade, count: q.grades[grade] })).filter(s => s.count > 0) : [];
  }

  gradeWord(grade: QualityGradeName): string {
    const q = this.quality();
    if (q && q.id !== CONSENSUS_ID && q.limits.every(l => l.levels === 2)) return grade === 'excellent' ? 'проходять' : grade === 'poor' ? 'не проходять' : GRADE_NAMES[grade];
    if (q?.id === CONSENSUS_ID) return grade === 'excellent' ? 'ніхто не відхиляє' : grade === 'good' ? '1 стандарт відхиляє' : grade === 'acceptable' ? '2 відхиляють' : '3+ відхиляють';
    return GRADE_NAMES[grade];
  }

  // --- the measures: a gauge each ---

  worstValue(limit: SolverQualityLimitDto): number {
    return this.quality()!.worst[limit.key];
  }

  worstGrade(limit: SolverQualityLimitDto): QualityGradeName {
    return metricGrade(limit, this.worstValue(limit));
  }

  passed(limit: SolverQualityLimitDto): boolean {
    return passes(limit, this.worstValue(limit));
  }

  ruleOf(limit: SolverQualityLimitDto): string {
    return limit.key === 'rejected' ? 'Допустимо: жоден стандарт не відхиляє' : ruleText(limit);
  }

  // What the big number of a gauge says: for the angles the worst angle itself, not its distance from 90.
  shownValue(limit: SolverQualityLimitDto): number {
    const q = this.quality()!;
    return limit.kind === 'angleDeviation' ? worstAngle(q.worst['minAngle'], q.worst['maxAngle']) : q.worst[limit.key];
  }

  sub(limit: SolverQualityLimitDto): string {
    const q = this.quality()!;
    return limit.kind === 'angleDeviation' ? `найменший ${q.worst['minAngle'].toFixed(0)}° · найбільший ${q.worst['maxAngle'].toFixed(0)}°` : '';
  }

  markerLeft(limit: SolverQualityLimitDto): string {
    return `${(gaugePosition(limit, this.worstValue(limit)) * 100).toFixed(1)}%`;
  }

  decimals(limit: SolverQualityLimitDto): string {
    return limit.kind === 'angleDeviation' ? '1.0-0' : `1.${limit.decimals}-${limit.decimals}`;
  }

  // --- the picked element ---

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

  // The picked element's measures: of the chosen standard, or - with the overall result chosen - of every standard.
  details(): { id: string; name: string; grade: QualityGradeName; rows: { limit: SolverQualityLimitDto; shown: string; grade: QualityGradeName; ok: boolean }[] }[] {
    const detail = this.solver.qualityDetail(this.sessionId);
    const report = this.report();
    const q = this.quality();
    if (!detail || !report || !q) return [];
    return report.profiles
      .filter(p => q.id === CONSENSUS_ID || p.id === q.id)
      .map(profile => {
        const one = detail.profiles.find(d => d.id === profile.id)!;
        return {
          id: profile.id,
          name: profile.name,
          grade: one.grade,
          rows: profile.limits.map(limit => {
            const value = one.values[limit.key];
            const grade = metricGrade(limit, value);
            const shown = limit.kind === 'angleDeviation' ? anglesText(one.values['minAngle'], one.values['maxAngle']) : `${value.toFixed(limit.decimals)}${limit.unit}`;
            return { limit, shown, grade, ok: grade !== 'poor' && grade !== 'invalid' };
          })
        };
      });
  }

  // How many standards reject the picked element (for the overall result).
  rejectedByCount(): number {
    return (this.solver.qualityDetail(this.sessionId)?.profiles ?? []).filter(p => p.grade === 'poor' || p.grade === 'invalid').length;
  }

  limitText(limit: SolverQualityLimitDto): string {
    return ruleText(limit);
  }

  // The element the standards reject most, for "show the problem" (not listed: the user finds it on the scene).
  private worstElement(): SolverElementQualityDto | null {
    const q = this.quality();
    if (!q) return null;
    const metric = this.metric();
    return q.flagged
      .filter(e => measuredGrade(e, metric, q.limits) !== 'excellent')
      .sort((a, b) => GRADE_ORDER.indexOf(measuredGrade(b, metric, q.limits)) - GRADE_ORDER.indexOf(measuredGrade(a, metric, q.limits)))[0] ?? null;
  }
}
