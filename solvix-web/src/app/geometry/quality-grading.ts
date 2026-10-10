import { QualityGradeName, QualityMetricKey, SolverQualityLimitDto } from '../api/solver-api.service';

// What a cube or a small element says about its quality.
export interface QualityMeasured {
  readonly grade: QualityGradeName;
  readonly scaledJacobian: number;
  readonly jacobianRatio: number;
  readonly aspectRatio: number;
  readonly skewDegrees: number;
}

// What the Quality World can colour the cubes by: the overall grade (the worst of the graded measures) or one measure.
export type QualityMetric = 'grade' | QualityMetricKey;

export const GRADE_ORDER: readonly QualityGradeName[] = ['excellent', 'good', 'acceptable', 'poor', 'invalid'];

export const GRADE_NAMES: Record<QualityGradeName, string> = {
  excellent: 'відмінний',
  good: 'добрий',
  acceptable: 'прийнятний',
  poor: 'поганий',
  invalid: 'невалідний'
};

export function metricValue(cube: QualityMeasured, key: QualityMetricKey): number {
  switch (key) {
    case 'scaledJacobian': return cube.scaledJacobian;
    case 'jacobianRatio': return cube.jacobianRatio;
    case 'aspectRatio': return cube.aspectRatio;
    case 'skew': return cube.skewDegrees;
  }
}

// The grade of one value by the limits of its measure (same rule as the server's ElementQuality).
export function metricGrade(limit: SolverQualityLimitDto, value: number): QualityGradeName {
  const [b0, b1, b2] = limit.bounds;
  if (limit.higherIsBetter) {
    if (!(value > 0)) return 'invalid';
    return value > b0 ? 'excellent' : value > b1 ? 'good' : value > b2 ? 'acceptable' : 'poor';
  }
  return value < b0 ? 'excellent' : value < b1 ? 'good' : value < b2 ? 'acceptable' : 'poor';
}

export function measuredGrade(cube: QualityMeasured, metric: QualityMetric, limits: readonly SolverQualityLimitDto[]): QualityGradeName {
  if (metric === 'grade') return cube.grade;
  const limit = limits.find(l => l.key === metric);
  return limit ? metricGrade(limit, metricValue(cube, metric)) : cube.grade;
}

export interface QualityProblem {
  readonly limit: SolverQualityLimitDto;
  readonly value: number;
  readonly grade: QualityGradeName;
}

// The measures of a cube that keep it from being excellent (graded ones only), worst first.
export function problemsOf(cube: QualityMeasured, limits: readonly SolverQualityLimitDto[]): QualityProblem[] {
  return limits
    .filter(l => l.graded)
    .map(limit => ({ limit, value: metricValue(cube, limit.key), grade: metricGrade(limit, metricValue(cube, limit.key)) }))
    .filter(p => p.grade !== 'excellent')
    .sort((a, b) => GRADE_ORDER.indexOf(b.grade) - GRADE_ORDER.indexOf(a.grade));
}

// A limit as text: "відмінно > 0.7 · добре > 0.4 · прийнятно > 0.15".
export function boundsText(limit: SolverQualityLimitDto): string {
  const sign = limit.higherIsBetter ? '>' : '<';
  const [b0, b1, b2] = limit.bounds;
  return `відмінно ${sign} ${b0} · добре ${sign} ${b1} · прийнятно ${sign} ${b2}`;
}

// How a measure is named in the panel: a plain word first, the technical name second, and a tip for the tooltip.
export const METRIC_TEXT: Record<QualityMetricKey, { title: string; short: string; tech: string; tip: string }> = {
  scaledJacobian: { title: 'Форма', short: 'Форма', tech: 'Scaled Jacobian', tip: '1 — ідеальний куб, 0 — елемент сплющений, менше 0 — вивернутий навиворіт.' },
  jacobianRatio: { title: 'Рівномірність', short: 'Рівномірн.', tech: 'Відношення якобіанів', tip: '1 — елемент розтягує простір скрізь однаково; близько 0 — в одному місці майже стиснутий, в іншому роздутий.' },
  aspectRatio: { title: 'Витягнутість', short: 'Витягнутість', tech: 'Aspect ratio', tip: 'Довше ребро поділене на коротше. Куб дає 1, чим більше — тим довша «паличка».' },
  skew: { title: 'Кути', short: 'Кути', tech: 'Перекіс, °', tip: 'Наскільки найгірший кут відхиляється від прямого (90°). Показано для довідки, на оцінку не впливає.' }
};

// Where a value sits on the gauge of its measure, 0..1: four equal zones, worst on the left (poor, acceptable, good,
// excellent), the value placed inside its zone in proportion.
export function gaugePosition(limit: SolverQualityLimitDto, value: number): number {
  const [b0, b1, b2] = limit.bounds;
  if (!Number.isFinite(value)) return limit.higherIsBetter ? 0 : 1;
  const within = (from: number, to: number) => (to === from ? 0 : Math.min(1, Math.max(0, (value - from) / (to - from))));
  if (limit.higherIsBetter) {
    // zones by value: [0, b2] poor, [b2, b1] acceptable, [b1, b0] good, [b0, 1] excellent
    if (value <= b2) return 0.25 * within(0, b2);
    if (value <= b1) return 0.25 + 0.25 * within(b2, b1);
    if (value <= b0) return 0.5 + 0.25 * within(b1, b0);
    return 0.75 + 0.25 * within(b0, 1);
  }
  // smaller is better: the excellent zone [0, b0] sits on the right
  if (value < b0) return 1 - 0.25 * within(0, b0);
  if (value < b1) return 0.75 - 0.25 * within(b0, b1);
  if (value < b2) return 0.5 - 0.25 * within(b1, b2);
  return 0.25 - 0.25 * within(b2, 2 * b2);
}

// The numbers between the zones, left to right (for either direction the worst limit comes first).
export function gaugeTicks(limit: SolverQualityLimitDto): number[] {
  return [limit.bounds[2], limit.bounds[1], limit.bounds[0]];
}

export interface GaugeZone {
  readonly grade: QualityGradeName;
  // the range of values that fall in this grade, as text
  readonly range: string;
}

const num = (v: number): string => String(v);

// The four grades of a measure from the worst (left) to the best (right) with the values that belong to each.
export function gaugeZones(limit: SolverQualityLimitDto): GaugeZone[] {
  const [b0, b1, b2] = limit.bounds;
  if (limit.higherIsBetter) {
    return [
      { grade: 'poor', range: `до ${num(b2)}` },
      { grade: 'acceptable', range: `${num(b2)} – ${num(b1)}` },
      { grade: 'good', range: `${num(b1)} – ${num(b0)}` },
      { grade: 'excellent', range: `від ${num(b0)}` }
    ];
  }
  return [
    { grade: 'poor', range: `від ${num(b2)}` },
    { grade: 'acceptable', range: `${num(b1)} – ${num(b2)}` },
    { grade: 'good', range: `${num(b0)} – ${num(b1)}` },
    { grade: 'excellent', range: `до ${num(b0)}` }
  ];
}

// Whether a value is allowed: excellent, good or acceptable pass; poor and invalid do not.
export function passes(limit: SolverQualityLimitDto, value: number): boolean {
  const grade = metricGrade(limit, value);
  return grade !== 'poor' && grade !== 'invalid';
}
