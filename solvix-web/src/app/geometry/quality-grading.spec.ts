import { SolverQualityLimitDto } from '../api/solver-api.service';
import { SolverQualityDto } from '../api/solver-api.service';
import { anglesText, decide, gaugePosition, gaugeTicks, gaugeZones, metricGrade, passes, ruleText, worstAngle } from './quality-grading';

const limit = (over: Partial<SolverQualityLimitDto>): SolverQualityLimitDto =>
  ({ key: 'k', label: '', short: '', tech: '', hint: '', higherIsBetter: true, levels: 4, bounds: [], unit: '', decimals: 2, kind: 'plain', errorBound: null, ...over });
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

describe('is the mesh accepted', () => {
  const limits = [
    limit({ key: 'jacobianRatio', label: 'Рівномірність якобіана', tech: 'Jacobian ratio', higherIsBetter: false, levels: 2, bounds: [30] }),
    limit({ key: 'aspectRatio', label: 'Витягнутість', tech: 'Aspect ratio', higherIsBetter: false, levels: 2, bounds: [20] })
  ];
  const solvix = (elements: number, flagged: { grade: 'poor' | 'invalid'; values: Record<string, number> }[]): SolverQualityDto => ({
    id: 'solvix', name: 'Solvix', source: '', note: '', elements,
    grades: { excellent: elements - flagged.length, good: 0, acceptable: 0, poor: flagged.filter(f => f.grade === 'poor').length, invalid: flagged.filter(f => f.grade === 'invalid').length },
    worst: {}, limits,
    flagged: flagged.map((f, i) => ({ hex: i, ex: 0, ey: 0, ez: 0, grade: f.grade, values: f.values }))
  });

  it('accepts a mesh in which no element is rejected', () => {
    const d = decide(solvix(10, []));

    expect(d.level).toBe('ok');
    expect(d.title).toBe('Сітка приймається');
    expect(d.rejected).toBe(0);
    expect(d.summary).toContain('Усі 10 елементів');
  });

  it('does not accept a mesh with a rejected element, and counts the elements that fail each measure', () => {
    const d = decide(solvix(10, [
      { grade: 'poor', values: { jacobianRatio: 45, aspectRatio: 3 } },
      { grade: 'poor', values: { jacobianRatio: 50, aspectRatio: 25 } },
      { grade: 'poor', values: { jacobianRatio: 2, aspectRatio: 30 } }
    ]));

    expect(d.level).toBe('bad');
    expect(d.title).toBe('Сітка не приймається');
    expect(d.rejected).toBe(3);
    expect(d.failing.map(f => `${f.tech} ${f.count}`)).toEqual(['Jacobian ratio 2', 'Aspect ratio 2']);
    expect(d.summary).toBe('3 із 10 елементів не проходять критерії Solvix.');
  });

  it('refuses a mesh with an inverted element', () => {
    const d = decide(solvix(10, [{ grade: 'invalid', values: { jacobianRatio: 1e9, aspectRatio: 1 } }]));

    expect(d.level).toBe('blocked');
    expect(d.folded).toBe(1);
    expect(d.advice).toContain('розрахунок не запуститься');
  });

  it('has nothing to judge without elements', () => {
    expect(decide(solvix(0, [])).title).toBe('Сітка порожня');
  });
});

describe('numbers on the quality gauge', () => {
  it('writes the far end, the limit and the ideal along the ruler', () => {
    expect(gaugeTicks(jacobian)).toEqual([{ at: 0, text: '0' }, { at: 50, text: '0.15' }, { at: 100, text: '1' }]);
    expect(gaugeTicks(aspect)).toEqual([{ at: 0, text: '60' }, { at: 50, text: '30' }, { at: 100, text: '0' }]);
    const angle = limit({ higherIsBetter: false, bounds: [20, 30, 45], unit: '°', kind: 'angleDeviation' });
    expect(gaugeTicks(angle).map(t => t.text)).toEqual(['90°', '45°', '0°']);
  });
});
