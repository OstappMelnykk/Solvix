import * as THREE from 'three';
import { SolverResultDto } from '../api/solver-api.service';

// The displacement vectors of a result as arrows at the nodes: one set of line segments (a shaft and a four-sided
// head each), so the whole field is a single draw call. An arrow points the way its node moves; its length and its
// colour (blue to red) say how far, relative to the largest displacement - the real lengths are far too small to see.
// `base` has every arrow at its undeformed node and `moved` at the node displaced by one unit of the result, so the
// arrows ride along with the deformation like the rest of the view (see Deformable in solver-view.ts).

const MAX_ARROWS = 8000;
const HEAD_LENGTH = 0.28;
const HEAD_WIDTH = 0.1;
// the shortest arrow is this fraction of the longest, so a small displacement still shows its direction
const SHORTEST = 0.15;
// below this fraction of the largest displacement a node does not get an arrow
const NEGLIGIBLE = 1e-3;

export interface ArrowSet {
  readonly base: number[];
  readonly moved: number[];
  readonly colors: number[];
  readonly count: number;
}

export function buildDisplacementArrows(result: SolverResultDto, rampColor: (t: number) => THREE.Color): ArrowSet | null {
  const nodes = result.positions.length / 3;
  const largest = result.maxDisplacement;
  if (nodes === 0 || !(largest > 0)) return null;

  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < result.positions.length; i++) {
    low[i % 3] = Math.min(low[i % 3], result.positions[i]);
    high[i % 3] = Math.max(high[i % 3], result.positions[i]);
  }
  const size = [high[0] - low[0], high[1] - low[1], high[2] - low[2]];
  const diagonal = Math.hypot(size[0], size[1], size[2]);
  // the longest arrow: a small part of the body, and no longer than the gap between neighbouring nodes
  const spacing = Math.cbrt(Math.max(size[0] * size[1] * size[2], diagonal ** 3 * 1e-3) / nodes);
  const longest = Math.min(0.07 * diagonal, 0.9 * spacing);

  const stride = Math.max(1, Math.ceil(nodes / MAX_ARROWS));
  const base: number[] = [];
  const moved: number[] = [];
  const colors: number[] = [];
  let count = 0;
  const point = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const side1 = new THREE.Vector3();
  const side2 = new THREE.Vector3();

  const segment = (a: THREE.Vector3, b: THREE.Vector3, u: readonly number[], color: THREE.Color) => {
    base.push(a.x, a.y, a.z, b.x, b.y, b.z);
    moved.push(a.x + u[0], a.y + u[1], a.z + u[2], b.x + u[0], b.y + u[1], b.z + u[2]);
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  };

  for (let n = 0; n < nodes; n += stride) {
    const u = [result.ux[n], result.uy[n], result.uz[n]];
    const magnitude = Math.hypot(u[0], u[1], u[2]);
    if (magnitude < NEGLIGIBLE * largest) continue;
    const t = Math.min(1, magnitude / largest);
    const length = longest * (SHORTEST + (1 - SHORTEST) * t);
    dir.set(u[0] / magnitude, u[1] / magnitude, u[2] / magnitude);
    // two directions across the arrow, for the head
    (Math.abs(dir.x) < 0.9 ? side1.set(1, 0, 0) : side1.set(0, 1, 0)).cross(dir).normalize();
    side2.copy(dir).cross(side1);

    point.set(result.positions[3 * n], result.positions[3 * n + 1], result.positions[3 * n + 2]);
    const tip = point.clone().addScaledVector(dir, length);
    const color = rampColor(t);
    segment(point, tip, u, color);
    const neck = tip.clone().addScaledVector(dir, -HEAD_LENGTH * length);
    for (const [s, sign] of [[side1, 1], [side1, -1], [side2, 1], [side2, -1]] as const) {
      segment(tip, neck.clone().addScaledVector(s, sign * HEAD_WIDTH * length), u, color);
    }
    count++;
  }
  return count === 0 ? null : { base, moved, colors, count };
}
