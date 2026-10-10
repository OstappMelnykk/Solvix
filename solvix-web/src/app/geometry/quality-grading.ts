import { QualityGradeName, SolverElementQualityDto, SolverQualityDto, SolverQualityLimitDto, SolverQualityReportDto } from '../api/solver-api.service';

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

// Where a value sits on the gauge of its measure, 0..1, the worst on the left. With four levels: four equal zones
// (poor, acceptable, good, excellent) and the value placed inside its zone in proportion. With two: failing on the
// left half, passing on the right half.
export function gaugePosition(limit: SolverQualityLimitDto, value: number): number {
  const [b0, b1, b2] = limit.bounds;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  if (!Number.isFinite(value)) return limit.higherIsBetter ? 0 : 1;
  if (limit.levels === 2) {
    const t = b0;
    const angle = limit.unit === '°';
    if (limit.higherIsBetter) {
      const ideal = angle ? 90 : 1;
      return value >= t ? 0.5 + 0.5 * clamp((value - t) / Math.max(1e-9, ideal - t)) : 0.5 - 0.5 * clamp((t - value) / Math.max(1e-9, t));
    }
    if (angle) return value <= t ? 0.5 + 0.5 * clamp((t - value) / Math.max(1e-9, t - 90)) : 0.5 - 0.5 * clamp((value - t) / Math.max(1e-9, 180 - t));
    return value <= t ? 1 - 0.5 * clamp(value / Math.max(1e-9, t)) : 0.5 - 0.5 * clamp((value - t) / Math.max(1e-9, t));
  }
  const within = (from: number, to: number) => (to === from ? 0 : clamp((value - from) / (to - from)));
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

export interface GaugeZone {
  readonly grade: QualityGradeName;
  // how the zone is called
  readonly label: string;
  // the range of values that fall in this zone, as text
  readonly range: string;
}

const num = (v: number): string => String(v);

// The zones of a measure from the worst (left) to the best (right) with the values that belong to each.
export function gaugeZones(limit: SolverQualityLimitDto): GaugeZone[] {
  const [b0, b1, b2] = limit.bounds;
  const u = limit.unit;
  if (limit.levels === 2) {
    return [
      { grade: 'poor', label: 'Не проходить', range: limit.higherIsBetter ? `менше ${num(b0)}${u}` : `більше ${num(b0)}${u}` },
      { grade: 'excellent', label: 'Проходить', range: limit.higherIsBetter ? `від ${num(b0)}${u}` : `до ${num(b0)}${u}` }
    ];
  }
  if (limit.kind === 'angleDeviation') {
    // the bounds are deviations from a right angle; shown as the angles they allow
    const around = (d: number) => `${90 - d}–${90 + d}°`;
    return [
      { grade: 'poor', label: GRADE_NAMES.poor, range: `<${90 - b2}° або >${90 + b2}°` },
      { grade: 'acceptable', label: GRADE_NAMES.acceptable, range: `${90 - b2}–${90 - b1}°, ${90 + b1}–${90 + b2}°` },
      { grade: 'good', label: GRADE_NAMES.good, range: `${90 - b1}–${90 - b0}°, ${90 + b0}–${90 + b1}°` },
      { grade: 'excellent', label: GRADE_NAMES.excellent, range: around(b0) }
    ];
  }
  if (limit.higherIsBetter) {
    return [
      { grade: 'poor', label: GRADE_NAMES.poor, range: `до ${num(b2)}` },
      { grade: 'acceptable', label: GRADE_NAMES.acceptable, range: `${num(b2)} – ${num(b1)}` },
      { grade: 'good', label: GRADE_NAMES.good, range: `${num(b1)} – ${num(b0)}` },
      { grade: 'excellent', label: GRADE_NAMES.excellent, range: `від ${num(b0)}` }
    ];
  }
  return [
    { grade: 'poor', label: GRADE_NAMES.poor, range: `від ${num(b2)}` },
    { grade: 'acceptable', label: GRADE_NAMES.acceptable, range: `${num(b1)} – ${num(b2)}` },
    { grade: 'good', label: GRADE_NAMES.good, range: `${num(b0)} – ${num(b1)}` },
    { grade: 'excellent', label: GRADE_NAMES.excellent, range: `до ${num(b0)}` }
  ];
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

export const CONSENSUS_ID = 'consensus';

// The "average" of the standards: for each element, in how many standards it is rejected. 0 excellent, 1 good, 2
// acceptable, 3 or more poor - so the standards vote, and an element only the strictest one dislikes stays mild.
export function buildConsensus(report: SolverQualityReportDto): SolverQualityDto {
  const profiles = report.profiles;
  const rejectedIn = new Map<string, { element: SolverElementQualityDto; count: number }>();
  for (const profile of profiles) {
    for (const element of profile.flagged) {
      if (!isRejected(element.grade)) continue;
      const key = `${element.hex}:${element.ex}:${element.ey}:${element.ez}`;
      const entry = rejectedIn.get(key);
      if (entry) entry.count++;
      else rejectedIn.set(key, { element, count: 1 });
    }
  }
  const total = profiles[0]?.elements ?? 0;
  const limit: SolverQualityLimitDto = {
    key: 'rejected',
    label: 'Скільки стандартів відхиляє',
    short: 'Відхиляють',
    tech: 'голосування',
    hint: `У скількох із ${profiles.length} стандартів елемент не проходить.`,
    higherIsBetter: false,
    levels: 4,
    bounds: [1, 2, 3],
    unit: '',
    decimals: 0,
    kind: 'plain'
  };
  const grades: Record<QualityGradeName, number> = { excellent: 0, good: 0, acceptable: 0, poor: 0, invalid: 0 };
  const flagged: SolverElementQualityDto[] = [];
  let most = 0;
  for (const { element, count } of rejectedIn.values()) {
    const grade = metricGrade(limit, count);
    grades[grade]++;
    most = Math.max(most, count);
    flagged.push({ hex: element.hex, ex: element.ex, ey: element.ey, ez: element.ez, grade, values: { rejected: count } });
  }
  grades.excellent = Math.max(0, total - flagged.length);
  return {
    id: CONSENSUS_ID,
    name: 'Консенсус',
    source: `Усереднення: у скількох із ${profiles.length} стандартів елемент не проходить. 0 — усі згодні, що добрий; 3 і більше — більшість відхиляє.`,
    note: 'Це не окремий стандарт, а голосування решти. Щоб побачити, хто саме відхиляє, оберіть стандарт у списку.',
    elements: total,
    grades,
    worst: { rejected: most },
    limits: [limit],
    flagged
  };
}

// The standards that reject an element, by name.
export function rejectedBy(report: SolverQualityReportDto, element: { hex: number; ex: number; ey: number; ez: number }): string[] {
  return report.profiles
    .filter(p => p.flagged.some(f => f.hex === element.hex && f.ex === element.ex && f.ey === element.ey && f.ez === element.ez && isRejected(f.grade)))
    .map(p => p.name);
}

// How many elements a standard rejects.
export function rejectedCount(profile: SolverQualityDto): number {
  return profile.grades.poor + profile.grades.invalid;
}

export type DecisionLevel = 'ok' | 'caution' | 'bad' | 'blocked';

export interface QualityDecision {
  readonly level: DecisionLevel;
  // "Можна рахувати"
  readonly title: string;
  // the reasons, one line each
  readonly reasons: readonly string[];
  // the standards that reject something, with how many elements
  readonly rejecting: readonly { name: string; rejected: number }[];
  // elements rejected by at least one standard / by most of them
  readonly rejectedByAny: number;
  readonly rejectedByMost: number;
  // whether going on to the solver is advised, allowed only with care, or not possible
  readonly canSolve: boolean;
}

// Whether the user may go on to the solver, from how all the standards judge the mesh:
//  - a folded element (invalid): not possible;
//  - elements rejected by most of the standards (3 or more of 5): better not;
//  - elements rejected by some standard but accepted by most: go on, with care;
//  - nothing rejected: go on.
export function decide(report: SolverQualityReportDto): QualityDecision {
  const consensus = buildConsensus(report);
  const rejecting = report.profiles.map(p => ({ name: p.name, rejected: rejectedCount(p) })).filter(r => r.rejected > 0);
  const folded = Math.max(0, ...report.profiles.map(p => p.grades.invalid));
  const byAny = consensus.flagged.length;
  const byMost = consensus.grades.poor + consensus.grades.invalid;
  const total = report.profiles[0]?.elements ?? 0;
  const names = rejecting.map(r => r.name).join(', ');
  const count = report.profiles.length;
  if (total === 0) return { level: 'ok', title: 'Сітка порожня', reasons: ['Побудуйте хоча б один куб.'], rejecting, rejectedByAny: 0, rejectedByMost: 0, canSolve: false };
  if (folded > 0) {
    return {
      level: 'blocked', title: 'Розрахунок неможливий',
      reasons: [`${folded} елементів вивернуті або вироджені — їх відхиляють усі стандарти.`, 'Виправте сітку (перетягніть вузли) або змініть поділ, поки такі елементи є, розрахунок не запуститься.'],
      rejecting, rejectedByAny: byAny, rejectedByMost: byMost, canSolve: false
    };
  }
  if (byMost > 0) {
    return {
      level: 'bad', title: 'Краще не рахувати',
      reasons: [`${byMost} елементів відхиляє більшість стандартів (3 і більше з ${count}).`, `Відхиляють: ${names}.`, 'Результат біля цих елементів буде неточним. Виправте їх або рахуйте на власний ризик.'],
      rejecting, rejectedByAny: byAny, rejectedByMost: byMost, canSolve: true
    };
  }
  if (byAny > 0) {
    return {
      level: 'caution', title: 'Можна рахувати, з обережністю',
      reasons: [`${byAny} елементів не проходять хоча б в одному стандарті, але більшість стандартів їх приймає.`, `Відхиляють: ${names}.`, 'Напруження поруч із ними можуть бути менш точними — перевірте їх на карті якості.'],
      rejecting, rejectedByAny: byAny, rejectedByMost: 0, canSolve: true
    };
  }
  return {
    level: 'ok', title: 'Можна рахувати',
    reasons: [`Усі ${total} елементів проходять у всіх ${count} стандартах.`],
    rejecting, rejectedByAny: 0, rejectedByMost: 0, canSolve: true
  };
}
