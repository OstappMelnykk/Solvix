import katex from 'katex';
import { explainFor } from './quality-explain';

describe('quality-explain', () => {
  // every measure of every profile in Solvix.Solver QualityProfiles
  const measures: Record<string, string[]> = {
    solvix: ['jacobianRatio', 'aspectRatio', 'parallelDeviation', 'maxCornerAngle', 'minCornerAngle', 'scaledJacobian', 'equiangleSkew', 'warpingFactor'],
    abaqus: ['faceMinAngle', 'faceMaxAngle', 'aspectRatio'],
    cubit: ['scaledJacobian', 'aspectRatio', 'skew', 'taper', 'stretch', 'diagonal', 'condition', 'shear', 'shape'],
    altair: ['aspectRatio', 'jacobian'],
    ansys: ['equiangleSkew']
  };

  for (const [tool, keys] of Object.entries(measures)) {
    for (const key of keys) {
      it(`explains ${tool} ${key} completely`, () => {
        const e = explainFor(tool, key);
        expect(e).not.toBeNull();
        expect(e!.what.length).toBeGreaterThan(10);
        expect(e!.formula.length).toBeGreaterThan(0);
        for (const line of e!.formula) expect(() => katex.renderToString(line, { throwOnError: true })).not.toThrow();      // real LaTeX, not text
        expect(e!.effect.length).toBeGreaterThan(10);
        expect(e!.ideal.length).toBeGreaterThan(1);
        expect(e!.extreme.length).toBeGreaterThan(1);
      });
    }
  }

  it('defines the aspect ratio per tool, because the tools mean different things by it', () => {
    expect(explainFor('solvix', 'aspectRatio')!.what).not.toEqual(explainFor('cubit', 'aspectRatio')!.what);
    expect(explainFor('abaqus', 'aspectRatio')!.formula[1]).toContain('\\frac{\\max_i L_i}');
  });

  it('knows nothing of an unknown measure', () => {
    expect(explainFor('solvix', 'nothing')).toBeNull();
  });
});
