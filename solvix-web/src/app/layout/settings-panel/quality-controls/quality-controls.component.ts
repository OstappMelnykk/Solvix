import { DoCheck, Component, Input, inject } from '@angular/core';
import { DecimalPipe, NgFor, NgIf } from '@angular/common';
import { QualityGradeName, SolverElementQualityDto, SolverQualityLimitDto } from '../../../api/solver-api.service';
import { GRADE_COLORS } from '../../../geometry/solver-view';
import { GRADE_NAMES, GRADE_ORDER, QualityMetric, boundsText, measuredGrade, metricGrade, metricValue } from '../../../geometry/quality-grading';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { QualityPick, SolverService, sameElement } from '../../../state/solver.service';

interface Row {
  readonly element: SolverElementQualityDto;
  readonly grade: QualityGradeName;
  readonly issues: readonly { label: string; value: number; grade: QualityGradeName; graded: boolean }[];
}

// The Quality World's panel: how well the elements the solver would use can be integrated, where the limits lie and
// which small elements break them. Picking an element here outlines it on the scene (and a click on an element there picks it here).
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
  readonly boundsText = boundsText;

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

  hexCount(): number {
    return this.editor.getState(this.sessionId)?.hexes.length ?? 0;
  }

  divisionsText(): string {
    return this.solver.divisions(this.sessionId).join(' × ');
  }

  refresh(): void {
    this.solver.refreshQuality(this.sessionId);
  }

  verdict(): string {
    const q = this.quality();
    if (!q) return '';
    if (q.grades.invalid > 0) return `Є невалідні елементи (${q.grades.invalid}): розрахунок неможливий`;
    if (q.grades.poor > 0) return `Є погані елементи (${q.grades.poor}): напруження біля них неточні`;
    if (q.grades.acceptable > 0) return 'Сітка придатна, є елементи середньої якості';
    return 'Сітка якісна';
  }

  verdictGrade(): QualityGradeName {
    const q = this.quality();
    return q ? (GRADE_ORDER.slice().reverse().find(g => q.grades[g] > 0) ?? 'excellent') : 'excellent';
  }

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

  decimals(limit: SolverQualityLimitDto): string {
    return limit.key === 'skew' ? '1.0-0' : limit.key === 'aspectRatio' ? '1.1-1' : '1.2-3';
  }

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
          .map(l => ({ label: l.label, value: metricValue(element, l.key), grade: metricGrade(l, metricValue(element, l.key)), graded: l.graded }))
          .filter(i => i.grade !== 'excellent')
      }))
      .filter(r => r.grade !== 'excellent')
      .sort((a, b) => GRADE_ORDER.indexOf(b.grade) - GRADE_ORDER.indexOf(a.grade) || a.element.scaledJacobian - b.element.scaledJacobian);
  }

  pickOf(element: SolverElementQualityDto): QualityPick {
    return { hex: element.hex, ex: element.ex, ey: element.ey, ez: element.ez };
  }

  isPicked(element: SolverElementQualityDto): boolean {
    const picked = this.solver.qualityPick(this.sessionId);
    return picked !== null && sameElement(picked, element);
  }

  pick(element: SolverElementQualityDto): void {
    this.solver.setQualityPick(this.sessionId, this.pickOf(element));
  }

  // A cube is cut into more than one element only when the division says so.
  placeText(element: SolverElementQualityDto): string {
    return this.solver.divisions(this.sessionId).some(n => n > 1) ? ` · елемент (${element.ex}, ${element.ey}, ${element.ez})` : '';
  }

  limitFor(label: string): SolverQualityLimitDto | undefined {
    return this.quality()?.limits.find(l => l.label === label);
  }

  valueText(label: string, value: number): string {
    const limit = this.limitFor(label);
    return limit?.key === 'skew' ? `${value.toFixed(0)}°` : limit?.key === 'aspectRatio' ? value.toFixed(1) : value.toFixed(2);
  }
}
