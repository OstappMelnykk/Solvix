import { SolverQualityLimitDto } from '../api/solver-api.service';
import { gaugePosition, metricGrade } from './quality-grading';

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
