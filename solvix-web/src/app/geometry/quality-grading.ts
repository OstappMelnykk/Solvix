import { QualityGradeName, SolverQualityDto, SolverQualityLimitDto, SolverQualityReportDto } from '../api/solver-api.service';

// What the Quality World can colour the elements by: the overall grade (the worst of the measures) or one measure.
export type QualityMetric = 'grade' | string;

export const GRADE_ORDER: readonly QualityGradeName[] = ['excellent', 'good', 'acceptable', 'poor', 'invalid'];

export const GRADE_NAMES: Record<QualityGradeName, string> = {
  excellent: 'відмінний',
  good: 'добрий',
  acceptable: 'прийнятний',
  poor: 'поганий',
  invalid: 'невалідний'
};

// What an element says about its quality.
export interface QualityMeasured {
  readonly grade: QualityGradeName;
  readonly values: Readonly<Record<string, number>>;
}

export function metricValue(element: QualityMeasured, key: string): number {
  return element.values[key] ?? NaN;
}

// The grade of one value by the limits of its measure (the same rule as the server's).
export function metricGrade(limit: SolverQualityLimitDto, value: number): QualityGradeName {
  if (!Number.isFinite(value)) return 'poor';
  const [b0, b1, b2] = limit.bounds;
  if (limit.levels === 2) return (limit.higherIsBetter ? value >= b0 : value <= b0) ? 'excellent' : 'poor';
  if (limit.higherIsBetter) {
    if (!(value > 0)) return 'invalid';
    return value > b0 ? 'excellent' : value > b1 ? 'good' : value > b2 ? 'acceptable' : 'poor';
  }
  return value < b0 ? 'excellent' : value < b1 ? 'good' : value < b2 ? 'acceptable' : 'poor';
}

export function measuredGrade(element: QualityMeasured, metric: QualityMetric, limits: readonly SolverQualityLimitDto[]): QualityGradeName {
  if (metric === 'grade') return element.grade;
  const limit = limits.find(l => l.key === metric);
  return limit ? metricGrade(limit, metricValue(element, metric)) : element.grade;
}

// The value from which an element passes a measure: the one limit of a pass/fail measure, or the last of the three
// limits of a graded one.
function passLimit(limit: SolverQualityLimitDto): number {
  return limit.levels === 2 ? limit.bounds[0] : limit.bounds[2];
}

// Where a value sits on the gauge of its measure, 0..1: not passing on the left half, passing on the right half, the
// ideal at the right end.
// A corner angle (ideal 90°), as against a deviation in degrees (ideal 0).
function isCornerAngle(limit: SolverQualityLimitDto): boolean {
  return limit.unit === '°' && limit.kind !== 'angleDeviation' && limit.key !== 'parallelDeviation';
}

// A lower-is-better measure with no upper bound (a ratio): its far end is infinity, not an invented number.
function isUnbounded(limit: SolverQualityLimitDto): boolean {
  return !limit.higherIsBetter && limit.unit !== '°' && limit.key !== 'equiangleSkew';
}

// How far a bounded lower-is-better measure goes on the gauge: its real maximum, or 180° for degrees.
function farEnd(limit: SolverQualityLimitDto, t: number): number {
  if (limit.key === 'equiangleSkew') return 1;
  return Math.min(2 * t, 180);
}

export function gaugePosition(limit: SolverQualityLimitDto, value: number): number {
  const t = passLimit(limit);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  if (!Number.isFinite(value)) return limit.higherIsBetter ? 0 : 1;
  const plainAngle = isCornerAngle(limit);
  if (limit.higherIsBetter) {
    const ideal = plainAngle ? 90 : 1;
    return value >= t ? 0.5 + 0.5 * clamp((value - t) / Math.max(1e-9, ideal - t)) : 0.5 - 0.5 * clamp((t - value) / Math.max(1e-9, t));
  }
  if (plainAngle) return value <= t ? 0.5 + 0.5 * clamp((t - value) / Math.max(1e-9, t - 90)) : 0.5 - 0.5 * clamp((value - t) / Math.max(1e-9, 180 - t));
  if (value <= t) return 1 - 0.5 * clamp(value / Math.max(1e-9, t));
  // beyond the limit of a ratio the marker slides towards the far end and reaches it only at infinity
  if (isUnbounded(limit)) return value >= 1e6 ? 0 : 0.5 * clamp(t / value);
  return 0.5 - 0.5 * clamp((value - t) / Math.max(1e-9, farEnd(limit, t) - t));
}

export interface GaugeZone {
  readonly result: Result;
  // how the zone is called
  readonly label: string;
  // the values that fall in this zone, as text
  readonly range: string;
}

// The two zones of a measure, the one that does not pass on the left, with the values that belong to each.
export function gaugeZones(limit: SolverQualityLimitDto): GaugeZone[] {
  const t = passLimit(limit);
  const u = limit.unit;
  if (limit.kind === 'angleDeviation') {
    return [
      { result: 'rejected', label: 'Не проходить', range: `<${90 - t}° або >${90 + t}°` },
      { result: 'accepted', label: 'Проходить', range: `${90 - t}–${90 + t}°` }
    ];
  }
  // a pass/fail measure lets the limit itself pass, a graded one needs to be beyond it
  const inclusive = limit.levels === 2;
  return [
    { result: 'rejected', label: 'Не проходить', range: limit.higherIsBetter ? (inclusive ? `менше ${t}${u}` : `до ${t}${u}`) : (inclusive ? `більше ${t}${u}` : `від ${t}${u}`) },
    { result: 'accepted', label: 'Проходить', range: limit.higherIsBetter ? (inclusive ? `від ${t}${u}` : `більше ${t}${u}`) : (inclusive ? `до ${t}${u}` : `менше ${t}${u}`) }
  ];
}

export interface GaugeTick {
  // 0..100: where on the gauge
  readonly at: number;
  readonly text: string;
}

// The numbers written on the gauge: its far end (not passing), the limit in the middle, the ideal at the passing end.
export function gaugeTicks(limit: SolverQualityLimitDto): GaugeTick[] {
  const t = passLimit(limit);
  const plainAngle = isCornerAngle(limit);
  const left = limit.higherIsBetter ? 0 : plainAngle ? 180 : isUnbounded(limit) ? Infinity : farEnd(limit, t);
  const right = limit.higherIsBetter ? (plainAngle ? 90 : 1) : plainAngle ? 90 : 0;
  const text = (v: number) => (Number.isFinite(v) ? `${Number(v.toFixed(2))}${limit.unit}` : '∞');
  return [{ at: 0, text: text(left) }, { at: 50, text: text(t) }, { at: 100, text: text(right) }];
}

// What a value has to be to pass, in words.
export function ruleText(limit: SolverQualityLimitDto): string {
  if (limit.kind === 'angleDeviation') return `Допустимо: кути від ${90 - limit.bounds[2]}° до ${90 + limit.bounds[2]}°`;
  if (limit.levels === 2) return `Допустимо: ${limit.higherIsBetter ? 'не менше' : 'не більше'} ${limit.bounds[0]}${limit.unit}`;
  return limit.higherIsBetter ? `Допустимо: більше ${limit.bounds[2]}` : `Допустимо: менше ${limit.bounds[2]}`;
}

// The angle that is farthest from a right angle (the one that decides the grade), and both ends as text.
export function worstAngle(smallest: number, largest: number): number {
  return 90 - smallest >= largest - 90 ? smallest : largest;
}

export function anglesText(smallest: number, largest: number): string {
  return `${smallest.toFixed(0)}°…${largest.toFixed(0)}°`;
}

// Whether a value is allowed: excellent, good or acceptable pass; poor and invalid do not.
export function passes(limit: SolverQualityLimitDto, value: number): boolean {
  const grade = metricGrade(limit, value);
  return grade !== 'poor' && grade !== 'invalid';
}

// An element is rejected by a standard when its grade there is poor or invalid.
export const isRejected = (grade: QualityGradeName): boolean => grade === 'poor' || grade === 'invalid';

// What the user sees of a grade: accepted or not. (The finer grades only say how far from the limit an element is; they
// decide nothing, so they are not shown.)
export type Result = 'accepted' | 'rejected';

export const RESULT_NAMES: Record<Result, string> = { accepted: 'Приймається', rejected: 'Не приймається' };

export function resultOf(grade: QualityGradeName): Result {
  return isRejected(grade) ? 'rejected' : 'accepted';
}

// The id of Solvix's own criterion in the report: the one that decides whether the mesh is accepted.
export const SOLVIX_ID = 'solvix';

export function solvixOf(report: SolverQualityReportDto): SolverQualityDto | null {
  return report.profiles.find(p => p.id === SOLVIX_ID) ?? null;
}

// How many elements a standard rejects.
export function rejectedCount(profile: SolverQualityDto): number {
  return profile.grades.poor + profile.grades.invalid;
}

export type DecisionLevel = 'ok' | 'bad' | 'blocked';

// The measures that rejected elements fail, with how many elements fail each (an element can fail several).
export interface FailingMeasure {
  readonly label: string;
  readonly tech: string;
  readonly count: number;
}

export interface QualityDecision {
  readonly level: DecisionLevel;
  // "Сітка приймається"
  readonly title: string;
  readonly total: number;
  readonly rejected: number;
  // inverted or degenerate elements (the Jacobian changes sign): the solver refuses them
  readonly folded: number;
  readonly failing: readonly FailingMeasure[];
  readonly advice: string;
  // one line for a narrow place
  readonly summary: string;
}

// Whether the mesh is accepted - by Solvix's criterion only (see docs/research/mesh-quality):
//  - an element is rejected when any measure is beyond its limit;
//  - an inverted element (Jacobian changes sign) cannot be used: the solver refuses it;
//  - the mesh is accepted when no element is rejected.
export function decide(solvix: SolverQualityDto): QualityDecision {
  const total = solvix.elements;
  const rejected = rejectedCount(solvix);
  const folded = solvix.grades.invalid;
  const failing = solvix.limits
    .map(limit => ({ label: limit.label, tech: limit.tech, count: solvix.flagged.filter(f => !passes(limit, f.values[limit.key])).length }))
    .filter(f => f.count > 0);
  if (total === 0) return { level: 'ok', title: 'Сітка порожня', total, rejected: 0, folded: 0, failing: [], advice: 'Побудуйте хоча б один куб.', summary: 'Побудуйте хоча б один куб.' };
  if (folded > 0) {
    return {
      level: 'blocked', title: 'Розрахунок неможливий', total, rejected, folded, failing,
      advice: 'Виправте сітку (перетягніть вузли) або змініть поділ. Поки такі елементи є, розрахунок не запуститься.',
      summary: `${folded} елементів вивернуті або вироджені.`
    };
  }
  if (rejected > 0) {
    return {
      level: 'bad', title: 'Сітка не приймається', total, rejected, folded, failing,
      advice: 'Результат біля цих елементів може бути неточним. Виправте їх або рахуйте на власний ризик.',
      summary: `${rejected} із ${total} елементів не проходять критерії Solvix.`
    };
  }
  return { level: 'ok', title: 'Сітка приймається', total, rejected, folded, failing, advice: '', summary: `Усі ${total} елементів проходять критерії Solvix.` };
}
