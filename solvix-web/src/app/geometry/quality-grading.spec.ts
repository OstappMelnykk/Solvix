import { SolverQualityLimitDto } from '../api/solver-api.service';
import { anglesText, gaugePosition, gaugeZones, metricGrade, passes, ruleText, worstAngle } from './quality-grading';

const jacobian: SolverQualityLimitDto = { key: 'scaledJacobian', label: '', hint: '', higherIsBetter: true, graded: true, bounds: [0.7, 0.4, 0.15] };
const aspect: SolverQualityLimitDto = { key: 'aspectRatio', label: '', hint: '', higherIsBetter: false, graded: true, bounds: [3, 10, 30] };

describe('quality gauge', () => {
  it('puts the worst on the left and the best on the right, a quarter for each grade', () => {
    expect(gaugePosition(jacobian, 0)).toBe(0);
    expect(gaugePosition(jacobian, 0.15)).toBeCloseTo(0.25, 6);
    expect(gaugePosition(jacobian, 0.4)).toBeCloseTo(0.5, 6);
    expect(gaugePosition(jacobian, 0.7)).toBeCloseTo(0.75, 6);
    expect(gaugePosition(jacobian, 1)).toBeCloseTo(1, 6);
    expect(gaugePosition(aspect, 1)).toBeGreaterThan(gaugePosition(aspect, 5));
    expect(gaugePosition(aspect, 3)).toBeCloseTo(0.75, 6);
    expect(gaugePosition(aspect, 10)).toBeCloseTo(0.5, 6);
    expect(gaugePosition(aspect, 30)).toBeCloseTo(0.25, 6);
    expect(gaugePosition(aspect, 1e9)).toBe(0);
  });

  it('grows with the grade and stays inside the gauge', () => {
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
  it('lists the grades from worst to best with the values that belong to each', () => {
    expect(gaugeZones(jacobian).map(z => `${z.grade} ${z.range}`)).toEqual(['poor до 0.15', 'acceptable 0.15 – 0.4', 'good 0.4 – 0.7', 'excellent від 0.7']);
    expect(gaugeZones(aspect).map(z => `${z.grade} ${z.range}`)).toEqual(['poor від 30', 'acceptable 10 – 30', 'good 3 – 10', 'excellent до 3']);
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
  const skew: SolverQualityLimitDto = { key: 'skew', label: '', hint: '', higherIsBetter: false, graded: true, bounds: [30, 45, 75] };

  it('allows angles from 15 to 165 degrees and calls 45 to 135 good', () => {
    expect(metricGrade(skew, 20)).toBe('excellent');         // angles 70-110
    expect(metricGrade(skew, 44)).toBe('good');              // 46-134
    expect(metricGrade(skew, 60)).toBe('acceptable');        // 30-150
    expect(metricGrade(skew, 80)).toBe('poor');              // 10-170
    expect(passes(skew, 74)).toBeTrue();
    expect(passes(skew, 76)).toBeFalse();
  });

  it('shows the limits as angles, not as distances from a right angle', () => {
    expect(gaugeZones(skew).map(z => `${z.grade} ${z.range}`)).toEqual([
      'poor <15° або >165°',
      'acceptable 15–45°, 135–165°',
      'good 45–60°, 120–135°',
      'excellent 60–120°'
    ]);
    expect(ruleText(skew)).toBe('Допустимо: кути від 15° до 165°');
  });

  it('names the angle that is farthest from a right angle', () => {
    expect(worstAngle(28, 110)).toBe(28);
    expect(worstAngle(80, 150)).toBe(150);
    expect(anglesText(27.6, 141.9)).toBe('28°…142°');
  });
});
