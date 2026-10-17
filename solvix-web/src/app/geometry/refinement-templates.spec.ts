import { MAX_N, MIN_N, TEMPLATES, childCount, hexVolume, templateOnUnitCube } from './refinement-templates';

describe('refinement templates on the unit cube', () => {
  for (const t of TEMPLATES) {
    for (let n = MIN_N; n <= MAX_N; n++) {
      it(`${t.kind} with n=${n} has ${t.formula} children that fill the cube`, () => {
        const { children } = templateOnUnitCube(t.kind, n);
        expect(children.length).toBe(childCount(t.kind, n));
        const total = children.reduce((s, ch) => s + hexVolume(ch), 0);
        expect(total).toBeCloseTo(1, 9);
      });
    }
  }

  it('counts match the formulas', () => {
    expect(childCount('T1', 3)).toBe(7);
    expect(childCount('T2', 3)).toBe(5);
    expect(childCount('T4', 3)).toBe(3);
  });
});
