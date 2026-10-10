import { QualityGradeName, QualityMetricKey, SolverCubeQualityDto, SolverQualityLimitDto } from '../api/solver-api.service';

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

export function metricValue(cube: SolverCubeQualityDto, key: QualityMetricKey): number {
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

export function cubeGrade(cube: SolverCubeQualityDto, metric: QualityMetric, limits: readonly SolverQualityLimitDto[]): QualityGradeName {
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
export function problemsOf(cube: SolverCubeQualityDto, limits: readonly SolverQualityLimitDto[]): QualityProblem[] {
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
