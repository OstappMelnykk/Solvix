import { SolverQualityLimitDto } from '../api/solver-api.service';
import { SolverQualityReportDto } from '../api/solver-api.service';
import { anglesText, buildConsensus, decide, gaugePosition, gaugeZones, metricGrade, passes, rejectedBy, ruleText, worstAngle } from './quality-grading';

const limit = (over: Partial<SolverQualityLimitDto>): SolverQualityLimitDto =>
  ({ key: 'k', label: '', short: '', tech: '', hint: '', higherIsBetter: true, levels: 4, bounds: [], unit: '', decimals: 2, kind: 'plain', ...over });
const jacobian = limit({ key: 'scaledJacobian', higherIsBetter: true, bounds: [0.7, 0.4, 0.15] });
const aspect = limit({ key: 'aspectRatio', higherIsBetter: false, bounds: [3, 10, 30] });

describe('quality gauge', () => {
  it('puts what does not pass on the left half and what passes on the right half, the ideal at the right end', () => {
    expect(gaugePosition(jacobian, 0)).toBe(0);
    expect(gaugePosition(jacobian, 0.15)).toBeCloseTo(0.5, 6);                 // the limit is the middle
    expect(gaugePosition(jacobian, 0.1)).toBeLessThan(0.5);
    expect(gaugePosition(jacobian, 0.4)).toBeGreaterThan(0.5);
    expect(gaugePosition(jacobian, 1)).toBeCloseTo(1, 6);
    expect(gaugePosition(aspect, 30)).toBeCloseTo(0.5, 6);
    expect(gaugePosition(aspect, 1)).toBeGreaterThan(gaugePosition(aspect, 5));
    expect(gaugePosition(aspect, 40)).toBeLessThan(0.5);
    expect(gaugePosition(aspect, 1e9)).toBe(0);
  });

  it('stays inside the gauge for any value', () => {
    for (const value of [-1, 0, 0.1, 0.3, 0.5, 0.9, 5]) {
      const p = gaugePosition(jacobian, value);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    expect(metricGrade(jacobian, 0.121)).toBe('poor');
    expect(metricGrade(aspect, 3.3)).toBe('good');
  });
});

describe('quality limits as text', () => {
  it('has two zones - what does not pass and what passes - with the values that belong to each', () => {
    expect(gaugeZones(jacobian).map(z => `${z.result}: ${z.range}`)).toEqual(['rejected: до 0.15', 'accepted: більше 0.15']);
    expect(gaugeZones(aspect).map(z => `${z.result}: ${z.range}`)).toEqual(['rejected: від 30', 'accepted: менше 30']);
  });

  it('lets excellent, good and acceptable pass and nothing else', () => {
    expect(passes(jacobian, 0.121)).toBeFalse();
    expect(passes(jacobian, 0.2)).toBeTrue();
    expect(passes(jacobian, -1)).toBeFalse();
    expect(passes(aspect, 3.3)).toBeTrue();
    expect(passes(aspect, 40)).toBeFalse();
  });
});

describe('angles', () => {
  const skew = limit({ key: 'skew', higherIsBetter: false, bounds: [30, 45, 75], kind: 'angleDeviation', unit: '°' });

  it('allows angles from 15 to 165 degrees and nothing beyond', () => {
    expect(passes(skew, 20)).toBeTrue();                     // angles 70-110
    expect(passes(skew, 60)).toBeTrue();                     // 30-150
    expect(passes(skew, 74)).toBeTrue();
    expect(passes(skew, 76)).toBeFalse();                    // 14-166
    expect(passes(skew, 80)).toBeFalse();
  });

  it('shows the limits as angles, not as distances from a right angle', () => {
    expect(gaugeZones(skew).map(z => `${z.result}: ${z.range}`)).toEqual(['rejected: <15° або >165°', 'accepted: 15–165°']);
    expect(ruleText(skew)).toBe('Допустимо: кути від 15° до 165°');
  });

  it('names the angle that is farthest from a right angle', () => {
    expect(worstAngle(28, 110)).toBe(28);
    expect(worstAngle(80, 150)).toBe(150);
    expect(anglesText(27.6, 141.9)).toBe('28°…142°');
  });
});

describe('standards that only pass or fail', () => {
  const abaqusMin = limit({ key: 'faceMinAngle', higherIsBetter: true, levels: 2, bounds: [10], unit: '°' });
  const abaqusAspect = limit({ key: 'aspectRatio', higherIsBetter: false, levels: 2, bounds: [10], decimals: 1 });

  it('lets a value equal to the limit pass and nothing beyond it', () => {
    expect(metricGrade(abaqusMin, 10)).toBe('excellent');
    expect(metricGrade(abaqusMin, 9.9)).toBe('poor');
    expect(metricGrade(abaqusAspect, 10)).toBe('excellent');
    expect(metricGrade(abaqusAspect, 10.1)).toBe('poor');
    expect(passes(abaqusAspect, NaN)).toBeFalse();
  });

  it('has two zones and puts a failing value in the left half and a passing one in the right', () => {
    expect(gaugeZones(abaqusAspect).map(z => `${z.label}: ${z.range}`)).toEqual(['Не проходить: більше 10', 'Проходить: до 10']);
    expect(gaugeZones(abaqusMin).map(z => `${z.label}: ${z.range}`)).toEqual(['Не проходить: менше 10°', 'Проходить: від 10°']);
    expect(gaugePosition(abaqusAspect, 30)).toBeLessThan(0.5);
    expect(gaugePosition(abaqusAspect, 2)).toBeGreaterThan(0.5);
    expect(gaugePosition(abaqusMin, 5)).toBeLessThan(0.5);
    expect(gaugePosition(abaqusMin, 60)).toBeGreaterThan(0.5);
    expect(ruleText(abaqusAspect)).toBe('Допустимо: не більше 10');
    expect(ruleText(abaqusMin)).toBe('Допустимо: не менше 10°');
  });
});

describe('the consensus of the standards', () => {
  const profile = (id: string, flagged: { hex: number; grade: 'good' | 'poor' }[], elements = 4) => ({
    id, name: id, source: '', note: '', elements,
    grades: { excellent: elements - flagged.length, good: 0, acceptable: 0, poor: flagged.filter(f => f.grade === 'poor').length, invalid: 0 },
    worst: {}, limits: [],
    flagged: flagged.map(f => ({ hex: f.hex, ex: 0, ey: 0, ez: 0, grade: f.grade, values: {} }))
  });
  const report: SolverQualityReportDto = {
    profiles: [
      profile('a', [{ hex: 0, grade: 'poor' }, { hex: 1, grade: 'poor' }, { hex: 2, grade: 'good' }]),
      profile('b', [{ hex: 0, grade: 'poor' }, { hex: 1, grade: 'poor' }]),
      profile('c', [{ hex: 0, grade: 'poor' }])
    ]
  };

  it('counts in how many standards each element is rejected, and ignores the ones that only grade it down', () => {
    const consensus = buildConsensus(report);
    const rejected = (hex: number) => consensus.flagged.find(f => f.hex === hex)?.values['rejected'];

    expect(rejected(0)).toBe(3);
    expect(rejected(1)).toBe(2);
    expect(rejected(2)).toBeUndefined();               // only graded 'good' in one: nobody rejects it
    expect(consensus.grades.poor).toBe(1);             // three votes
    expect(consensus.grades.acceptable).toBe(1);       // two votes
    expect(consensus.grades.excellent).toBe(2);
    expect(consensus.worst['rejected']).toBe(3);
  });

  it('names the standards that reject an element', () => {
    expect(rejectedBy(report, { hex: 1, ex: 0, ey: 0, ez: 0 })).toEqual(['a', 'b']);
    expect(rejectedBy(report, { hex: 2, ex: 0, ey: 0, ez: 0 })).toEqual([]);
  });
});

describe('can the solver be used', () => {
  const profile = (id: string, elements: number, flagged: { hex: number; grade: 'good' | 'poor' | 'invalid' }[]) => ({
    id, name: id, source: '', note: '', elements,
    grades: { excellent: elements - flagged.length, good: flagged.filter(f => f.grade === 'good').length, acceptable: 0, poor: flagged.filter(f => f.grade === 'poor').length, invalid: flagged.filter(f => f.grade === 'invalid').length },
    worst: {}, limits: [],
    flagged: flagged.map(f => ({ hex: f.hex, ex: 0, ey: 0, ez: 0, grade: f.grade, values: {} }))
  });
  const reportOf = (...perProfile: { hex: number; grade: 'good' | 'poor' | 'invalid' }[][]): SolverQualityReportDto => ({ profiles: perProfile.map((f, i) => profile(`s${i}`, 10, f)) });
  const poor = (hex: number) => ({ hex, grade: 'poor' as const });

  it('says go on when nobody rejects anything', () => {
    const d = decide(reportOf([], [], [], [], []));

    expect(d.level).toBe('ok');
    expect(d.canSolve).toBeTrue();
    expect(d.total).toBe(10);
    expect(d.advice).toBe('');
  });

  it('says go on with care when some standards reject elements but not most of them', () => {
    const d = decide(reportOf([], [poor(1)], [poor(1), poor(2)], [], []));

    expect(d.level).toBe('caution');
    expect(d.canSolve).toBeTrue();
    expect(d.rejectedByAny).toBe(2);
    expect(d.total).toBe(10);
    expect(d.advice).toContain('Перевірте');
    expect(d.rejecting.map(r => r.name)).toEqual(['s1', 's2']);
  });

  it('advises against when most of the standards reject an element', () => {
    const d = decide(reportOf([poor(1)], [poor(1)], [poor(1)], [], []));

    expect(d.level).toBe('bad');
    expect(d.rejectedByMost).toBe(1);
    expect(d.reasons.join(' ')).toContain('s0, s1, s2');
  });

  it('does not allow the solver with a folded element', () => {
    const d = decide(reportOf([{ hex: 1, grade: 'invalid' }], [{ hex: 1, grade: 'invalid' }], [], [], []));

    expect(d.level).toBe('blocked');
    expect(d.canSolve).toBeFalse();
    expect(d.folded).toBe(1);
    expect(d.advice).toContain('розрахунок не запуститься');
  });

  it('has nothing to judge without elements', () => {
    expect(decide({ profiles: [profile('a', 0, [])] }).canSolve).toBeFalse();
  });
});
