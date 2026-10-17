// The three transition templates of local refinement (Owen, Shih, Ernst) drawn on the unit cube: the same construction as
// Solvix.FemMesh/Local/Templates.cs, only on a parent cube of side 1, so the popup can show what a template does to one cell.
// A slot is a corner of the cube: bit 0 is x, bit 1 is y, bit 2 is z.

export type Vec3 = readonly [number, number, number];
export type TemplateKind = 'T1' | 'T2' | 'T4';

export interface TemplateInfo {
  readonly kind: TemplateKind;
  readonly label: string;
  readonly marked: string;
  readonly formula: string;
}

export const TEMPLATES: readonly TemplateInfo[] = [
  { kind: 'T1', label: 'T1 · кут', marked: 'позначений кут', formula: '3n − 2' },
  { kind: 'T2', label: 'T2 · ребро', marked: 'позначене ребро', formula: '2n − 1' },
  { kind: 'T4', label: 'T4 · грань', marked: 'позначена грань', formula: 'n' }
];

export const MIN_N = 2;
export const MAX_N = 6;

const bit = (slot: number, b: number): number => (slot >> b) & 1;
const others = (axis: number): [number, number] => (axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]);

export function unitCorners(): Vec3[] {
  return Array.from({ length: 8 }, (_, s): Vec3 => [bit(s, 0), bit(s, 1), bit(s, 2)]);
}

// a + (b - a) * numerator / n
function along(a: Vec3, b: Vec3, numerator: number, n: number): Vec3 {
  return [a[0] + ((b[0] - a[0]) * numerator) / n, a[1] + ((b[1] - a[1]) * numerator) / n, a[2] + ((b[2] - a[2]) * numerator) / n];
}

export function childCount(kind: TemplateKind, n: number): number {
  return kind === 'T1' ? 3 * n - 2 : kind === 'T2' ? 2 * n - 1 : n;
}

// T1 around corner k: n nested copies scaled about the corner, three plates between neighbouring ones.
export function cornerChildren(c: readonly Vec3[], k: number, n: number): Vec3[][] {
  const scaled = (a: number, b: number, cc: number, s: number): Vec3 => along(c[k], c[k ^ (a | (b << 1) | (cc << 2))], s, n);
  const children: Vec3[][] = [];
  const add = (corner: (a: number, b: number, cc: number) => Vec3): void => {
    const corners: Vec3[] = new Array<Vec3>(8);
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++)
        for (let cc = 0; cc < 2; cc++) corners[(a ^ bit(k, 0)) | ((b ^ bit(k, 1)) << 1) | ((cc ^ bit(k, 2)) << 2)] = corner(a, b, cc);
    children.push(corners);
  };
  for (let m = n; m >= 2; m--) {
    add((a, b, cc) => scaled(1, b, cc, a === 1 ? m : m - 1));
    add((a, b, cc) => scaled(a, 1, cc, b === 1 ? m : m - 1));
    add((a, b, cc) => scaled(a, b, 1, cc === 1 ? m : m - 1));
  }
  add((a, b, cc) => scaled(a, b, cc, 1));
  return children;
}

// T2 along the edge that runs along `axis` and starts at slot `start`: the cross-section's T1, kept along the edge.
export function edgeChildren(c: readonly Vec3[], axis: number, start: number, n: number): Vec3[][] {
  const [u, v] = others(axis);
  const pu = bit(start, u);
  const pv = bit(start, v);
  const scaled = (su: number, sv: number, e: number, s: number): Vec3 => {
    const baseSlot = (e << axis) | (pu << u) | (pv << v);
    const slot = (e << axis) | ((pu ^ su) << u) | ((pv ^ sv) << v);
    return along(c[baseSlot], c[slot], s, n);
  };
  const children: Vec3[][] = [];
  const add = (corner: (au: number, av: number, ae: number) => Vec3): void => {
    const corners: Vec3[] = new Array<Vec3>(8);
    for (let au = 0; au < 2; au++)
      for (let av = 0; av < 2; av++)
        for (let ae = 0; ae < 2; ae++) corners[((au ^ pu) << u) | ((av ^ pv) << v) | (ae << axis)] = corner(au, av, ae);
    children.push(corners);
  };
  for (let m = n; m >= 2; m--) {
    add((au, av, ae) => scaled(1, av, ae, au === 1 ? m : m - 1));
    add((au, av, ae) => scaled(au, 1, ae, av === 1 ? m : m - 1));
  }
  add((au, av, ae) => scaled(au, av, ae, 1));
  return children;
}

// T4: n slabs parallel to the face on the given side of the given axis.
export function faceChildren(c: readonly Vec3[], axis: number, side: number, n: number): Vec3[][] {
  const [u, v] = others(axis);
  const layer = (su: number, sv: number, j: number): Vec3 =>
    along(c[(side << axis) | (su << u) | (sv << v)], c[((1 - side) << axis) | (su << u) | (sv << v)], j, n);
  const children: Vec3[][] = [];
  for (let i = 0; i < n; i++) {
    const corners: Vec3[] = new Array<Vec3>(8);
    for (let au = 0; au < 2; au++)
      for (let av = 0; av < 2; av++)
        for (let af = 0; af < 2; af++) corners[((af ^ side) << axis) | (au << u) | (av << v)] = layer(au, av, i + af);
    children.push(corners);
  }
  return children;
}

// The children of the template on the unit cube, and the marked part (its slots) that the template is built around.
export function templateOnUnitCube(kind: TemplateKind, n: number): { children: Vec3[][]; markedSlots: number[] } {
  const c = unitCorners();
  if (kind === 'T1') return { children: cornerChildren(c, 0, n), markedSlots: [0] };
  if (kind === 'T2') return { children: edgeChildren(c, 0, 0, n), markedSlots: [0, 1] };
  return { children: faceChildren(c, 0, 0, n), markedSlots: [0, 2, 4, 6] };
}

// The six faces of a hexahedron as slot quadruples (in loop order).
export const HEX_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 2, 6, 4],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 1, 3, 2],
  [4, 5, 7, 6]
];

// The twelve edges of a hexahedron as slot pairs.
export const HEX_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7]
];

// The volume of a (convex) hexahedron: the tetrahedra from its centre to the triangles that split each face about the face's centre.
export function hexVolume(p: readonly Vec3[]): number {
  const centre = p.reduce<Vec3>((s, q) => [s[0] + q[0] / 8, s[1] + q[1] / 8, s[2] + q[2] / 8], [0, 0, 0]);
  let vol = 0;
  for (const f of HEX_FACES) {
    const q = f.map((s) => p[s]);
    const m = q.reduce<Vec3>((s, r) => [s[0] + r[0] / 4, s[1] + r[1] / 4, s[2] + r[2] / 4], [0, 0, 0]);
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const ax = a[0] - centre[0], ay = a[1] - centre[1], az = a[2] - centre[2];
      const bx = b[0] - centre[0], by = b[1] - centre[1], bz = b[2] - centre[2];
      const mx = m[0] - centre[0], my = m[1] - centre[1], mz = m[2] - centre[2];
      vol += Math.abs(ax * (by * mz - bz * my) - ay * (bx * mz - bz * mx) + az * (bx * my - by * mx)) / 6;
    }
  }
  return vol;
}
