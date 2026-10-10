import { DoCheck, Component, Input, inject } from '@angular/core';
import { DecimalPipe, NgFor, NgIf } from '@angular/common';
import { QualityGradeName, QualityMetricKey, SolverElementQualityDto, SolverQualityLimitDto } from '../../../api/solver-api.service';
import { GRADE_COLORS } from '../../../geometry/solver-view';
import { GRADE_NAMES, GRADE_ORDER, METRIC_TEXT, QualityMetric, gaugePosition, gaugeZones, measuredGrade, metricGrade, metricValue, passes, ruleText, worstAngle, anglesText } from '../../../geometry/quality-grading';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { QualityPick, SolverService, sameElement } from '../../../state/solver.service';

interface Row {
  readonly element: SolverElementQualityDto;
  readonly grade: QualityGradeName;
  readonly issues: readonly { key: QualityMetricKey; value: number; grade: QualityGradeName; graded: boolean }[];
}

// The Quality World's panel: is the mesh good enough, which measure is the weak one, and where are the bad elements.
// Picking an element in the list outlines it on the scene (and a click on an element there picks it here).
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

  @Input({ required: true }) sessionId!: number;

  readonly gradeOrder = GRADE_ORDER;
  readonly gradeNames = GRADE_NAMES;
  readonly text = METRIC_TEXT;
  readonly gaugeZones = gaugeZones;

  // The quality follows the mesh: it is asked again whenever the mesh or the division changed.
  ngDoCheck(): void {
    this.solver.ensureQuality(this.sessionId);
  }

  quality() {
    return this.solver.quality(this.sessionId);
  }

  metric(): QualityMetric {
    return this.solver.qualityMetric(this.sessionId);
  }

  setMetric(metric: QualityMetric): void {
    this.solver.setQualityMetric(this.sessionId, metric);
  }

  gradeColor(grade: QualityGradeName): string {
    return `#${GRADE_COLORS[grade].toString(16).padStart(6, '0')}`;
  }

  hexCount(): number {
    return this.editor.getState(this.sessionId)?.hexes.length ?? 0;
  }

  refresh(): void {
    this.solver.refreshQuality(this.sessionId);
  }

  // --- the verdict ---

  verdictGrade(): QualityGradeName {
    const q = this.quality();
    return q ? (GRADE_ORDER.slice().reverse().find(g => q.grades[g] > 0) ?? 'excellent') : 'excellent';
  }

  verdict(): { title: string; sub: string } {
    const q = this.quality();
    if (!q) return { title: '', sub: '' };
    if (q.grades.invalid > 0) return { title: 'Розрахунок неможливий', sub: `Вивернутих елементів: ${q.grades.invalid}` };
    if (q.grades.poor > 0) return { title: 'Є погані елементи', sub: `${q.grades.poor} — напруження біля них будуть неточні` };
    if (q.grades.acceptable > 0) return { title: 'Сітка придатна', sub: `${q.grades.acceptable} елементів середньої якості` };
    return { title: 'Сітка якісна', sub: 'Усі елементи добрі або відмінні' };
  }

  // The bar of all elements by grade: only the grades that occur, as wide as their share.
  segments(): { grade: QualityGradeName; count: number }[] {
    const q = this.quality();
    return q ? GRADE_ORDER.map(grade => ({ grade, count: q.grades[grade] })).filter(s => s.count > 0) : [];
  }

  // --- the measures: a gauge each ---

  worstValue(limit: SolverQualityLimitDto): number {
    const q = this.quality()!;
    switch (limit.key) {
      case 'scaledJacobian': return q.worstScaledJacobian;
      case 'jacobianRatio': return q.worstJacobianRatio;
      case 'aspectRatio': return q.worstAspectRatio;
      case 'skew': return q.worstSkewDegrees;
    }
  }

  worstGrade(limit: SolverQualityLimitDto): QualityGradeName {
    return metricGrade(limit, this.worstValue(limit));
  }

  passed(limit: SolverQualityLimitDto): boolean {
    return passes(limit, this.worstValue(limit));
  }

  // The line between allowed and not allowed, in words: what a value has to be to pass.
  rule(limit: SolverQualityLimitDto): string {
    return ruleText(limit);
  }

  // What the big number of a gauge says: for the angles the worst angle itself, not its distance from 90.
  shownValue(limit: SolverQualityLimitDto): number {
    const q = this.quality()!;
    return limit.key === 'skew' ? worstAngle(q.smallestAngleDegrees, q.largestAngleDegrees) : this.worstValue(limit);
  }

  sub(limit: SolverQualityLimitDto): string {
    const q = this.quality()!;
    return limit.key === 'skew' ? `найменший ${q.smallestAngleDegrees.toFixed(0)}° · найбільший ${q.largestAngleDegrees.toFixed(0)}°` : '';
  }

  markerLeft(limit: SolverQualityLimitDto): string {
    return `${(gaugePosition(limit, this.worstValue(limit)) * 100).toFixed(1)}%`;
  }

  decimals(limit: SolverQualityLimitDto): string {
    return limit.key === 'skew' ? '1.0-0' : limit.key === 'aspectRatio' ? '1.1-1' : '1.2-2';
  }

  unit(limit: SolverQualityLimitDto): string {
    return limit.key === 'skew' ? '°' : '';
  }

  // --- the bad elements ---

  // The small elements that are not excellent by what the scene is coloured by, the worst first. (An element the
  // server did not flag is excellent in every measure.)
  rows(): Row[] {
    const q = this.quality();
    if (!q) return [];
    const metric = this.metric();
    return q.flagged
      .map(element => ({
        element,
        grade: measuredGrade(element, metric, q.limits),
        issues: q.limits
          .map(l => ({ key: l.key, value: metricValue(element, l.key), grade: metricGrade(l, metricValue(element, l.key)), graded: l.graded }))
          .filter(i => i.grade !== 'excellent')
      }))
      .filter(r => r.grade !== 'excellent')
      .sort((a, b) => GRADE_ORDER.indexOf(b.grade) - GRADE_ORDER.indexOf(a.grade) || a.element.scaledJacobian - b.element.scaledJacobian);
  }

  valueText(key: QualityMetricKey, value: number, element?: SolverElementQualityDto): string {
    return key === 'skew' ? (element ? anglesText(element.minAngleDegrees, element.maxAngleDegrees) : `${value.toFixed(0)}°`) : key === 'aspectRatio' ? value.toFixed(1) : value.toFixed(2);
  }

  isPicked(element: SolverElementQualityDto): boolean {
    const picked = this.solver.qualityPick(this.sessionId);
    return picked !== null && sameElement(picked, element);
  }

  pick(element: SolverElementQualityDto): void {
    const pick: QualityPick = { hex: element.hex, ex: element.ex, ey: element.ey, ez: element.ez };
    this.solver.setQualityPick(this.sessionId, pick);
  }

  // A cube is cut into more than one element only when the division says so.
  placeText(element: SolverElementQualityDto): string {
    return this.solver.divisions(this.sessionId).some(n => n > 1) ? ` · (${element.ex}, ${element.ey}, ${element.ez})` : '';
  }
}
