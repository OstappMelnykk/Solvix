import * as THREE from 'three';
import { SolverResultDto } from '../api/solver-api.service';
import { buildDisplacementArrows } from './displacement-arrows';

const colour = () => new THREE.Color(0xff0000);
const result = (ux: number[], uy: number[], uz: number[]): SolverResultDto =>
  ({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    ux, uy, uz,
    maxDisplacement: Math.max(...ux.map((_, i) => Math.hypot(ux[i], uy[i], uz[i])))
  }) as unknown as SolverResultDto;

describe('displacement arrows', () => {
  it('draws one arrow (a shaft and a four-sided head) per node that moves', () => {
    const arrows = buildDisplacementArrows(result([1, 0, 0, 0.5], [0, 0, 0, 0], [0, 0, 0, 0]), colour)!;

    expect(arrows.count).toBe(2);
    expect(arrows.base.length).toBe(2 * 5 * 6);        // 5 segments of 2 points each
    expect(arrows.colors.length).toBe(arrows.base.length);
  });

  it('points the way the node moves, the longest for the largest displacement', () => {
    const arrows = buildDisplacementArrows(result([2, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0]), colour)!;
    const shaft = (arrow: number) => {
      const o = arrow * 30;
      return new THREE.Vector3(arrows.base[o + 3] - arrows.base[o], arrows.base[o + 4] - arrows.base[o + 1], arrows.base[o + 5] - arrows.base[o + 2]);
    };

    expect(shaft(0).normalize().x).toBeCloseTo(1, 6);
    expect(shaft(1).normalize().y).toBeCloseTo(1, 6);
    expect(shaft(0).length()).toBeGreaterThan(shaft(1).length());
  });

  it('carries every vertex of an arrow with its node by the node\'s displacement', () => {
    const arrows = buildDisplacementArrows(result([3, 0, 0, 0], [0, 0, 0, 0], [0, 0, 4, 0]), colour)!;

    for (let i = 0; i < arrows.base.length; i += 3) {
      const first = i < 30;                       // the arrow of the first node
      expect(arrows.moved[i] - arrows.base[i]).toBeCloseTo(first ? 3 : 0, 6);
      expect(arrows.moved[i + 2] - arrows.base[i + 2]).toBeCloseTo(first ? 0 : 4, 6);
    }
  });

  it('draws nothing without a displacement', () => {
    expect(buildDisplacementArrows(result([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), colour)).toBeNull();
  });
});
