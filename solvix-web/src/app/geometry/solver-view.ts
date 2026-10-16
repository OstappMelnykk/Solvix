import * as THREE from 'three';
import { HexFaceName, MeshHexDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { QualityGradeName, SolverFaceDto, SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { markForWeightedOit } from '../rendering/weighted-oit';
import { buildDisplacementArrows } from './displacement-arrows';
import { Result } from './quality-grading';
import { LOCAL_COORDS, MeshView, PickedFace, mapHex } from './mesh-editor-view';

// The Solver World's drawing of a body, the way the solver's own viewer shows its mesh: every cube cut into
// nx*ny*nz small elements, the faces of the elements that are visible drawn as small faces with their curved edges,
// coloured by the element's material or - after a solve - by a field of the solution; clamped faces in blue,
// pressed faces in green; the body can be drawn deformed, see-through (order-independent transparency), with some
// materials hidden so the elements behind them show, and with the faces between elements drawn.

export type SolverField = 'none' | 'vonMises' | 'displacement';

export interface SolverViewInput {
  readonly state: MeshStateDto;
  readonly setup: SolverSetupDto | null;
  readonly result: SolverResultDto | null;
  readonly field: SolverField;
  // Exaggeration of the displacements when the body is drawn deformed (0 = undeformed).
  readonly deformationScale: number;
  // 0..1: how opaque the cubes are (1 = solid).
  readonly opacity: number;
  // Materials whose elements are not drawn.
  readonly hiddenMaterials?: ReadonlySet<string>;
  // Also draw the faces between visible elements (the grid inside the body).
  readonly showInner?: boolean;
  // The value that gets the last colour of the ramp (default: the largest value of the field); larger values are
  // painted the same, so one hot spot does not wash out the rest.
  readonly colorMax?: number | null;
  // Opacity of the coats of the clamped and pressed faces (default 0.62; 0 leaves them out): a light coat keeps the
  // field underneath readable.
  readonly marksOpacity?: number;
  // Which marks are drawn (default both): the clamped faces and the pressed faces.
  readonly showFixed?: boolean;
  readonly showLoads?: boolean;
  // Draw the displacement vectors (default yes); the view can show and hide them later without a rebuild.
  readonly vectors?: boolean;
}

// A cut through a body: the real coordinate `axis` equal to `at`, and the side that is kept.
export interface SectionCut {
  readonly axis: 0 | 1 | 2;
  readonly at: number;
  readonly keep: 'above' | 'below';
}

const EDGE_SEGMENTS = 8;
const EDGE_COLOR = 0x1a1d23;
export const FIXED_COLOR = 0x3388ff;
export const LOAD_COLOR = 0x44ff44;
// One colour for the loads, in tones: the weaker the pressure, the paler the green; the strongest is the full one.
export function pressureColor(all: readonly number[], pressure: number): number {
  const distinct = Array.from(new Set(all.map(Math.abs))).sort((a, b) => a - b);
  if (distinct.length <= 1) return LOAD_COLOR;
  const rank = Math.max(0, distinct.indexOf(Math.abs(pressure)));
  const tone = 0.3 + 0.7 * (rank / (distinct.length - 1));
  return new THREE.Color(LOAD_COLOR).multiplyScalar(tone).getHex();
}
const HIGHLIGHT_COLOR = 0xffe14d;
export const OVERLAY_OPACITY = 0.62;
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();

// Blue -> cyan -> green -> yellow -> red.
const RAMP: readonly THREE.Color[] = [0x2b3cc4, 0x2bb5d6, 0x3fc46a, 0xf0d43a, 0xe4572e].map(hex => new THREE.Color(hex));

// Colour of a value in [0, 1] on the ramp (values outside are clamped).
export function rampColor(t: number): THREE.Color {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return RAMP[i].clone().lerp(RAMP[i + 1], x - i);
}

export const RAMP_STEPS = 256;
export const RAMP_TABLE: readonly (readonly [number, number, number])[] = Array.from({ length: RAMP_STEPS + 1 }, (_, i) => {
  const c = rampColor(i / RAMP_STEPS);
  return [c.r, c.g, c.b] as const;
});

// A geometry that moves with the deformation: its vertices are base + scale * displacement (the surface is linear in
// the nodes, so the displacement of a vertex is fixed once and any scale is a single pass over a buffer), and its
// colours can follow a new range of the field without rebuilding anything.
export interface Deformable {
  readonly geometry: THREE.BufferGeometry;
  readonly base: Float32Array;
  readonly displacement: Float32Array;
  // per vertex, only for a surface coloured by a field
  readonly values?: Float32Array;
  readonly light?: Float32Array;
}

// The ready-made materials have colours that read as what they are, so layers are told apart at a glance.
const KNOWN_COLORS: Record<string, number> = {
  steel: 0x7da7d9,
  aluminium: 0xcfd6dd,
  concrete: 0xb8a98a,
  rubber: 0xe0605a,
  enamel: 0xf4efe0,
  dentin: 0xe8c27a,
  bone: 0xc8b98a
};

// Colour of a quality grade: green good ... red invalid.
export const GRADE_COLORS: Record<QualityGradeName, number> = {
  excellent: 0x2fbf4f,
  good: 0x9bd04a,
  acceptable: 0xf0d43a,
  poor: 0xf08a2e,
  invalid: 0xe02b2b
};

// The colours of a quality result: accepted or not.
export const RESULT_COLORS: Record<Result, number> = { accepted: 0x2fbf4f, rejected: 0xe02b2b };

// A stable colour per material name, so the same material looks the same everywhere.
// The colours the user gave to materials of his own (by name); set from the solver's set-up whenever it arrives.
const customColors = new Map<string, string>();

export function setMaterialColors(materials: readonly { readonly name: string; readonly color?: string }[]): void {
  customColors.clear();
  for (const m of materials) if (m.color) customColors.set(m.name, m.color);
}

export function materialColor(name: string): THREE.Color {
  const own = customColors.get(name);
  if (own !== undefined) return new THREE.Color(own);
  const known = KNOWN_COLORS[name];
  if (known !== undefined) return new THREE.Color(known);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.55, 0.56);
}

export interface FieldRange {
  readonly min: number;
  readonly max: number;
}

// The values of a field at each node of the solved mesh.
export function fieldValues(result: SolverResultDto, field: SolverField): number[] | null {
  if (field === 'none') return null;
  if (field === 'vonMises') return [...result.vonMises];
  return result.ux.map((_, i) => Math.sqrt(result.ux[i] ** 2 + result.uy[i] ** 2 + result.uz[i] ** 2));
}

export function fieldRange(values: readonly number[]): FieldRange {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return values.length === 0 ? { min: 0, max: 0 } : { min, max };
}

// The existing grid points (ix, iy, iz) of a divided cube - at most one odd index - iz slowest, ix fastest: the
// order in which the server lists the nodes of each cube.
export function gridPoints(nx: number, ny: number, nz: number): [number, number, number][] {
  const points: [number, number, number][] = [];
  for (let iz = 0; iz <= 2 * nz; iz++)
    for (let iy = 0; iy <= 2 * ny; iy++)
      for (let ix = 0; ix <= 2 * nx; ix++) if ((ix % 2) + (iy % 2) + (iz % 2) <= 1) points.push([ix, iy, iz]);
  return points;
}

// The 8 nodes of a small face on its (u, v) in [-1, 1]^2: 4 corners then 4 edge midpoints.
const FACE_NODES: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]];
// The edges as (corner, midpoint, corner) of FACE_NODES.
const FACE_EDGES: readonly (readonly [number, number, number])[] = [[0, 4, 1], [1, 5, 2], [2, 6, 3], [3, 7, 0]];
// The 12 edges of an element as (corner, corner) of the editor's 20 nodes; edge k has its midpoint at slot 8 + k.
const ELEMENT_EDGES: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

function faceShape(i: number, u: number, v: number): number {
  const [ui, vi] = FACE_NODES[i];
  if (ui !== 0 && vi !== 0) return 0.25 * (1 + u * ui) * (1 + v * vi) * (u * ui + v * vi - 1);
  if (ui === 0) return 0.5 * (1 - u * u) * (1 + v * vi);
  return 0.5 * (1 + u * ui) * (1 - v * v);
}

const AXIS_NAME = ['X', 'Y', 'Z'] as const;

export function faceName(axis: number, plus: boolean): HexFaceName {
  return `${AXIS_NAME[axis]}${plus ? 'Plus' : 'Minus'}` as HexFaceName;
}

// ---------------------------------------------------------------------------------------------------------------
// the positions and values of the divided mesh

export interface SmallFace {
  readonly positions: THREE.Vector3[];
  readonly values: number[];
}

// Where the grid points of every cube are (undeformed, or deformed by the result) and what the field is there.
// Where a small element is, for a body cut into `divisions` small elements per cube: its centre in the real world.
export function elementCentreOf(state: MeshStateDto, divisions: readonly number[], pick: { hex: number; ex: number; ey: number; ez: number }): THREE.Vector3 | null {
  const hex = state.hexes.find(h => h.id === pick.hex);
  return hex ? new SolverGeometry(state, divisions, null, 0, 'none').elementCentre(hex, pick.ex, pick.ey, pick.ez) : null;
}

// ---- cutting by the plane of a section ----------------------------------------------------------------------------------

const alongOf = (axis: 0 | 1 | 2, x: number, y: number, z: number): number => (axis === 0 ? x : axis === 1 ? y : z);

// A face that lies exactly in the plane of a cut belongs to the kept side, however the float32 rounding of its coordinates
// falls: the plane is moved this far out to the removed side.
export const planeSlack = (cut: SectionCut): number => 2e-6 * (1 + Math.abs(cut.at));

// The outlines in which the plane cuts a small element: the segments in which it crosses the triangles of the element's six
// faces, chained end to end into closed loops (a loop is a list of points). Usually one loop; none if the plane misses the
// element. (Ordering the points by their angle round the centre, as this used to, gives a star of thin spikes as soon as the
// cut is not convex - which a bent or folded element's is.)
export function elementSectionLoops(faces: readonly { positions: number[]; indices: number[] }[], cut: SectionCut, report?: { open: number }): THREE.Vector3[][] {
  const key = (p: THREE.Vector3) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`;
  const segments: [THREE.Vector3, THREE.Vector3][] = [];
  const seen = new Set<string>();
  for (const { positions, indices } of faces) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const v = [0, 1, 2].map(k => new THREE.Vector3(positions[3 * indices[t + k]], positions[3 * indices[t + k] + 1], positions[3 * indices[t + k] + 2]));
      const d = v.map(p => alongOf(cut.axis, p.x, p.y, p.z) - cut.at);
      const crossings: THREE.Vector3[] = [];
      const add = (p: THREE.Vector3) => {
        if (!crossings.some(q => key(q) === key(p))) crossings.push(p);
      };
      for (let k = 0; k < 3; k++) {
        const a = k, b = (k + 1) % 3;
        if (d[a] === 0) add(v[a].clone());
        else if ((d[a] < 0) !== (d[b] < 0) && d[b] !== 0) add(v[a].clone().lerp(v[b], d[a] / (d[a] - d[b])));
      }
      if (crossings.length === 2) {
        // (a triangle lying in the plane gives none; an edge lying in it is met from both of its triangles: kept once)
        const name = [key(crossings[0]), key(crossings[1])].sort().join('|');
        if (!seen.has(name)) {
          seen.add(name);
          segments.push([crossings[0], crossings[1]]);
        }
      }
    }
  }
  // chain: each point joins the segments that end in it
  const ends = new Map<string, number[]>();
  segments.forEach(([p, q], i) => {
    for (const point of [p, q]) {
      const k = key(point);
      ends.set(k, [...(ends.get(k) ?? []), i]);
    }
  });
  const used = new Set<number>();
  const loops: THREE.Vector3[][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used.has(start)) continue;
    used.add(start);
    const loop = [segments[start][0], segments[start][1]];
    let closed = false;
    for (;;) {
      const last = loop[loop.length - 1];
      const next = (ends.get(key(last)) ?? []).find(i => !used.has(i));
      if (next === undefined) break;
      used.add(next);
      const [p, q] = segments[next];
      loop.push(key(p) === key(last) ? q : p);
      if (key(loop[loop.length - 1]) === key(loop[0])) { loop.pop(); closed = true; break; }
    }
    if (closed && loop.length >= 3) loops.push(loop);
    else if (report) report.open++;                   // a chain that does not close: the cut has a gap here
  }
  return loops;
}

// A loop cut into triangles (indices into the loop). Ear clipping, which also handles a loop that is not convex; if the
// loop is degenerate (zero area) a fan from its first point is used instead.
export function triangulateLoop(loop: readonly THREE.Vector3[], axis: 0 | 1 | 2): number[][] {
  const [u, w] = [0, 1, 2].filter(i => i !== axis);
  const at = (p: THREE.Vector3, i: number) => (i === 0 ? p.x : i === 1 ? p.y : p.z);
  const contour = loop.map(p => new THREE.Vector2(at(p, u), at(p, w)));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  if (triangles.length > 0) return triangles;
  return Array.from({ length: loop.length - 2 }, (_, i) => [0, i + 1, i + 2]);
}

const SECTION_COLOR = 0x39c5f2;

// The sheet that shows a cut: a rectangle across the whole body (a little beyond it), with an outline. Not pickable.
export function sectionPlane(state: MeshStateDto, cut: SectionCut): THREE.Group {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const n of state.nodes) {
    const p = [n.x, n.y, n.z];
    for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i], p[i]);
      high[i] = Math.max(high[i], p[i]);
    }
  }
  const [a, b] = [0, 1, 2].filter(i => i !== cut.axis);
  const pad = (i: number) => Math.max(1e-6, (high[i] - low[i]) * 0.08);
  const corner = (u: number, v: number): number[] => {
    const p = [0, 0, 0];
    p[cut.axis] = cut.at;
    p[a] = u;
    p[b] = v;
    return p;
  };
  const [u0, u1, v0, v1] = [low[a] - pad(a), high[a] + pad(a), low[b] - pad(b), high[b] + pad(b)];
  const c = [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
  const sheet = new THREE.BufferGeometry();
  sheet.setAttribute('position', new THREE.Float32BufferAttribute([...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]], 3));
  const outline = new THREE.BufferGeometry();
  outline.setAttribute('position', new THREE.Float32BufferAttribute([...c[0], ...c[1], ...c[1], ...c[2], ...c[2], ...c[3], ...c[3], ...c[0]], 3));
  const group = new THREE.Group();
  group.add(new THREE.Mesh(sheet, new THREE.MeshBasicMaterial({ color: SECTION_COLOR, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })));
  group.add(new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: SECTION_COLOR })));
  return group;
}

export class SolverGeometry {
  readonly counts: [number, number, number];
  private readonly points: [number, number, number][];
  private readonly pointIndex: Map<string, number>;
  private readonly nodes: Map<number, { x: number; y: number; z: number }>;
  private readonly hexIndexInResult: Map<number, number>;
  private readonly slotPositions = new Map<number, THREE.Vector3[]>();
  private readonly values: number[] | null;

  constructor(
    private readonly state: MeshStateDto,
    divisions: readonly number[],
    private readonly result: SolverResultDto | null,
    private readonly scale: number,
    field: SolverField
  ) {
    this.counts = [divisions[0], divisions[1], divisions[2]];
    this.points = gridPoints(...this.counts);
    this.pointIndex = new Map(this.points.map((p, i) => [p.join(','), i]));
    this.nodes = new Map(state.nodes.map(n => [n.id, n]));
    this.hexIndexInResult = new Map((result?.hexIds ?? []).map((id, i) => [id, i]));
    this.values = result ? fieldValues(result, field) : null;
  }

  get hasField(): boolean {
    return this.values !== null;
  }

  // How far a small element reaches along an axis (its corners and centre; a curved edge may bulge a hair past them).
  elementExtent(hex: MeshHexDto, ex: number, ey: number, ez: number, axis: 0 | 1 | 2): { min: number; max: number } {
    const [nx, ny, nz] = this.counts;
    const slots = this.slots(hex);
    let min = Infinity, max = -Infinity;
    for (const cx of [2 * ex, 2 * ex + 1, 2 * ex + 2])
      for (const cy of [2 * ey, 2 * ey + 1, 2 * ey + 2])
        for (const cz of [2 * ez, 2 * ez + 1, 2 * ez + 2]) {
          if ((cx === 2 * ex + 1 ? 1 : 0) + (cy === 2 * ey + 1 ? 1 : 0) + (cz === 2 * ez + 1 ? 1 : 0) === 2) continue;      // face centres: not needed
          const p = mapHex(slots, cx / nx - 1, cy / ny - 1, cz / nz - 1);
          const along = axis === 0 ? p.x : axis === 1 ? p.y : p.z;
          min = Math.min(min, along);
          max = Math.max(max, along);
        }
    return { min, max };
  }

  // The centre of a small element in the real world.
  elementCentre(hex: MeshHexDto, ex: number, ey: number, ez: number): THREE.Vector3 {
    const [nx, ny, nz] = this.counts;
    return mapHex(this.slots(hex), (2 * ex + 1) / nx - 1, (2 * ey + 1) / ny - 1, (2 * ez + 1) / nz - 1);
  }

  private slots(hex: MeshHexDto): THREE.Vector3[] {
    let slots = this.slotPositions.get(hex.id);
    if (!slots) {
      slots = LOCAL_COORDS.map((_, s) => {
        const node = this.nodes.get(hex.nodeIds[s])!;
        return new THREE.Vector3(node.x, node.y, node.z);
      });
      this.slotPositions.set(hex.id, slots);
    }
    return slots;
  }

  private nodeAt(hex: MeshHexDto, ix: number, iy: number, iz: number): number | null {
    const at = this.hexIndexInResult.get(hex.id);
    return this.result && at !== undefined ? this.result.gridNodes[at * this.points.length + this.pointIndex.get(`${ix},${iy},${iz}`)!] : null;
  }

  position(hex: MeshHexDto, ix: number, iy: number, iz: number): THREE.Vector3 {
    const node = this.nodeAt(hex, ix, iy, iz);
    const result = this.result;
    if (node === null || !result) return mapHex(this.slots(hex), ix / this.counts[0] - 1, iy / this.counts[1] - 1, iz / this.counts[2] - 1);
    const point = new THREE.Vector3(result.positions[3 * node], result.positions[3 * node + 1], result.positions[3 * node + 2]);
    return this.scale !== 0 ? point.add(new THREE.Vector3(result.ux[node], result.uy[node], result.uz[node]).multiplyScalar(this.scale)) : point;
  }

  value(hex: MeshHexDto, ix: number, iy: number, iz: number): number {
    const node = this.nodeAt(hex, ix, iy, iz);
    return node === null || !this.values ? 0 : this.values[node];
  }

  // The small face on plane t (0..n) of an axis, in cell (p, q) of that plane's grid.
  smallFace(hex: MeshHexDto, axis: number, t: number, p: number, q: number): SmallFace {
    const [t0, t1] = [0, 1, 2].filter(d => d !== axis);
    const positions: THREE.Vector3[] = [];
    const values: number[] = [];
    for (const [u, v] of FACE_NODES) {
      const index = [0, 0, 0];
      index[axis] = 2 * t;
      index[t0] = 2 * p + u + 1;
      index[t1] = 2 * q + v + 1;
      positions.push(this.position(hex, index[0], index[1], index[2]));
      values.push(this.value(hex, index[0], index[1], index[2]));
    }
    return { positions, values };
  }

  // The 12 curved edges of a small element as line segments (flat x, y, z pairs).
  elementEdges(hex: MeshHexDto, ex: number, ey: number, ez: number, segments = EDGE_SEGMENTS): number[] {
    const node = (s: number) => this.position(hex, 2 * ex + LOCAL_COORDS[s][0] + 1, 2 * ey + LOCAL_COORDS[s][1] + 1, 2 * ez + LOCAL_COORDS[s][2] + 1);
    const out: number[] = [];
    ELEMENT_EDGES.forEach(([a, b], k) => pushEdge(out, node(a), node(8 + k), node(b), segments));
    return out;
  }
}

function pushEdge(out: number[], start: THREE.Vector3, mid: THREE.Vector3, end: THREE.Vector3, segments: number): void {
  let previous = start;
  for (let i = 1; i <= segments; i++) {
    const t = (i / segments) * 2 - 1;
    const next = start.clone().multiplyScalar((t * (t - 1)) / 2).addScaledVector(mid, 1 - t * t).addScaledVector(end, (t * (t + 1)) / 2);
    out.push(previous.x, previous.y, previous.z, next.x, next.y, next.z);
    previous = next;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the faces that are drawn

export interface DrawnFace {
  // the cube whose grid gives the geometry
  readonly drawer: MeshHexDto;
  readonly axis: number;
  readonly t: number;
  readonly p: number;
  readonly q: number;
  // the visible element behind the face, and its cube
  readonly owner: MeshHexDto;
  readonly element: [number, number, number];
  // the face of that element the face is
  readonly face: HexFaceName;
  // lies on the outside of the body (so it can carry a load or a clamp)
  readonly outer: boolean;
}

// How finely a small face is cut when drawn: smooth enough to follow the curved surface whatever the division. The
// same grid carries the material, the clamp and load coats and the highlight, so they lie on one another exactly.
export function faceResolution(divisions: readonly number[]): number {
  return Math.max(3, Math.ceil(12 / Math.max(...divisions)));
}

// Triangles of one small face - a (resolution x resolution) grid, two triangles per cell.
const trianglesPerFace = (resolution: number) => 2 * resolution * resolution;

// Appends the smooth surface of a small face (its 8 nodes through the face shape functions) to a vertex/index list.
// A point of a small face at (u, v) in [-1, 1].
export function facePoint(face: SmallFace, u: number, v: number): THREE.Vector3 {
  const point = new THREE.Vector3();
  for (let k = 0; k < 8; k++) point.addScaledVector(face.positions[k], faceShape(k, u, v));
  return point;
}

export function appendSurface(positions: number[], indices: number[], face: SmallFace, resolution: number, onVertex?: (u: number, v: number, value: number) => void): void {
  const base = positions.length / 3;
  const stride = resolution + 1;
  for (let iv = 0; iv <= resolution; iv++) {
    for (let iu = 0; iu <= resolution; iu++) {
      const u = (iu / resolution) * 2 - 1;
      const v = (iv / resolution) * 2 - 1;
      const point = new THREE.Vector3();
      let value = 0;
      for (let k = 0; k < 8; k++) {
        const w = faceShape(k, u, v);
        point.addScaledVector(face.positions[k], w);
        value += w * face.values[k];
      }
      positions.push(point.x, point.y, point.z);
      onVertex?.(u, v, value);
    }
  }
  for (let iv = 0; iv < resolution; iv++) {
    for (let iu = 0; iu < resolution; iu++) {
      const a = base + iv * stride + iu;
      indices.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
    }
  }
}

export function buildSolverView(input: SolverViewInput): MeshView {
  const { state, setup, result, field } = input;
  const root = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const divisions = (result ? result.divisions : (setup?.divisions ?? [1, 1, 1])) as [number, number, number];
  const geometry = new SolverGeometry(state, divisions, result, 0, field);
  // the same mesh displaced by one unit of the result: its difference from `geometry` is the displacement
  const displaced = result ? new SolverGeometry(state, divisions, result, 1, field) : null;
  const deformables: Deformable[] = [];
  const counts = geometry.counts;
  const hidden = input.hiddenMaterials ?? new Set<string>();
  const opacity = Math.min(1, Math.max(0.05, input.opacity));
  const solid = opacity >= 1;
  const values = result ? fieldValues(result, field) : null;
  const range: FieldRange = values ? { min: 0, max: input.colorMax && input.colorMax > 0 ? input.colorMax : fieldRange(values).max } : { min: 0, max: 0 };
  const span = range.max - range.min;

  const hexById = new Map(state.hexes.map(h => [h.id, h]));
  const links = new Map<string, { hex: number; face: HexFaceName }>();
  for (const f of state.faces) if (f.status === 'Linked' && f.otherHex !== null && f.otherFace !== null) links.set(`${f.hex}:${f.face}`, { hex: f.otherHex, face: f.otherFace });

  const overrides = new Map((setup?.elementMaterials ?? []).map(m => [`${m.hex}:${m.ex}:${m.ey}:${m.ez}`, m.material]));
  const materialOf = (hex: number, ex: number, ey: number, ez: number): string =>
    overrides.get(`${hex}:${ex}:${ey}:${ez}`) ?? setup?.hexMaterials[hex] ?? setup?.defaultMaterial ?? 'default';
  // an element is drawn unless its material is hidden
  const visible = (hex: number, ex: number, ey: number, ez: number): boolean => !hidden.has(materialOf(hex, ex, ey, ez));

  const isFixed = new Set((setup?.fixed ?? []).map(f => `${f.hex}:${f.face}:${f.p}:${f.q}`));
  const pressureOf = new Map((setup?.loads ?? []).map(l => [`${l.hex}:${l.face}:${l.p}:${l.q}`, l.pressure]));
  const isLoaded = new Set(pressureOf.keys());
  const allPressures = Array.from(pressureOf.values());

  // ---- which faces to draw: those between a visible element and what is not (or, with showInner, all of them) ----
  const drawn = new Map<number, DrawnFace[]>();
  for (const hex of state.hexes) {
    for (let axis = 0; axis < 3; axis++) {
      const [t0, t1] = [0, 1, 2].filter(d => d !== axis);
      for (let t = 0; t <= counts[axis]; t++) {
        for (let p = 0; p < counts[t0]; p++) {
          for (let q = 0; q < counts[t1]; q++) {
            const index = (along: number): [number, number, number] => {
              const e: [number, number, number] = [0, 0, 0];
              e[axis] = along;
              e[t0] = p;
              e[t1] = q;
              return e;
            };
            const lowIndex = t > 0 ? index(t - 1) : null;
            const highIndex = t < counts[axis] ? index(t) : null;
            let low: { hex: MeshHexDto; element: [number, number, number] } | null = lowIndex ? { hex, element: lowIndex } : null;
            let high: { hex: MeshHexDto; element: [number, number, number] } | null = highIndex ? { hex, element: highIndex } : null;
            let linked = false;
            if (!low || !high) {
              // on a side of the cube: across it is the next cube, or nothing
              const name = faceName(axis, t > 0);
              const link = links.get(`${hex.id}:${name}`);
              if (link) {
                linked = true;
                const other = hexById.get(link.hex);
                if (!other || other.id < hex.id) continue;               // a shared face is drawn once, from the lower cube
                const across = index(t > 0 ? 0 : counts[axis] - 1);
                if (t > 0) high = { hex: other, element: across };
                else low = { hex: other, element: across };
              }
            }
            const lowVisible = low !== null && visible(low.hex.id, ...low.element);
            const highVisible = high !== null && visible(high.hex.id, ...high.element);
            const keep = lowVisible !== highVisible || (lowVisible && highVisible && input.showInner === true);
            if (!keep) continue;
            const ownerIsHigh = highVisible;                              // with both visible: the high side
            const owner = ownerIsHigh ? high! : low!;
            const entry: DrawnFace = {
              drawer: hex,
              axis, t, p, q,
              owner: owner.hex,
              element: owner.element,
              face: faceName(axis, !ownerIsHigh),                         // the high element meets the face on its minus side
              outer: !linked && (t === 0 || t === counts[axis])
            };
            (drawn.get(hex.id) ?? (drawn.set(hex.id, []), drawn.get(hex.id)!)).push(entry);
          }
        }
      }
    }
  }

  // ---- geometry: one mesh per cube, and one merged set of lines -----------------------------------------------------
  const resolution = faceResolution(counts);
  const triangles = trianglesPerFace(resolution);
  const lines: number[] = [];
  const movedLines: number[] = [];

  const faceGeometry = (faces: readonly DrawnFace[], colorOf: (face: DrawnFace, value: number) => THREE.Color, shade: boolean, byField = false): THREE.BufferGeometry => {
    const positions: number[] = [];
    const moved: number[] = [];
    const colors: number[] = [];
    const vertexValues: number[] = [];
    const indices: number[] = [];
    for (const face of faces) {
      const small = geometry.smallFace(face.drawer, face.axis, face.t, face.p, face.q);
      appendSurface(positions, indices, small, resolution, (_u, _v, value) => {
        const color = colorOf(face, value);
        colors.push(color.r, color.g, color.b);
        vertexValues.push(value);
      });
      if (displaced) appendSurface(moved, [], displaced.smallFace(face.drawer, face.axis, face.t, face.p, face.q), resolution);
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    buffer.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    buffer.setIndex(indices);
    const light = new Float32Array(positions.length / 3).fill(1);
    if (shade) {
      // a fixed light baked into the colours: a face turned away from it is darker, which is what lets the eye read the shape
      buffer.computeVertexNormals();
      const normal = buffer.getAttribute('normal');
      const color = buffer.getAttribute('color');
      for (let i = 0; i < normal.count; i++) {
        light[i] = 0.58 + 0.42 * Math.abs(normal.getX(i) * LIGHT.x + normal.getY(i) * LIGHT.y + normal.getZ(i) * LIGHT.z);
        color.setXYZ(i, color.getX(i) * light[i], color.getY(i) * light[i], color.getZ(i) * light[i]);
      }
    }
    if (displaced) deformables.push(deformable(buffer, positions, moved, byField ? vertexValues : undefined, light));
    return buffer;
  };

  const pendingOverlays: { color: number; faces: DrawnFace[] }[] = [];
  for (const [hexId, faces] of drawn) {
    const hex = hexById.get(hexId)!;
    for (const face of faces) {
      const small = geometry.smallFace(hex, face.axis, face.t, face.p, face.q);
      for (const [a, m, b] of FACE_EDGES) pushEdge(lines, small.positions[a], small.positions[m], small.positions[b], EDGE_SEGMENTS);
      if (displaced) {
        const far = displaced.smallFace(face.drawer, face.axis, face.t, face.p, face.q);
        for (const [a, m, b] of FACE_EDGES) pushEdge(movedLines, far.positions[a], far.positions[m], far.positions[b], EDGE_SEGMENTS);
      }
    }
    const colorOf = (face: DrawnFace, value: number) =>
      values ? rampColor(span > 0 ? (value - range.min) / span : 0) : materialColor(materialOf(face.owner.id, ...face.element));
    const addBody = (subset: readonly DrawnFace[], subsetOpacity: number): void => {
    const subsetSolid = subsetOpacity >= 1;
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !subsetSolid, opacity: subsetOpacity, depthWrite: subsetSolid });
    // see-through: handed to the order-independent transparency pass, which blends without sorting
    markForWeightedOit(material);
    const bodyGeometry = faceGeometry(subset, colorOf, true, values !== null);
    const mesh = new THREE.Mesh(bodyGeometry, material);
    // a click lands on a triangle; its small face is the triangle's number divided by the triangles of one small face
    mesh.userData['resolvePick'] = (triangle: number): PickedFace | null => {
      const face = subset[Math.floor(triangle / triangles)];
      return face
        ? { kind: 'face', hex: face.owner.id, face: face.face, p: face.p, q: face.q, element: face.element, inner: !face.outer }
        : null;
    };
    mesh.userData['pick'] = mesh.userData['resolvePick'](0);
    root.add(mesh);
    pickables.push(mesh);
    };
    addBody(faces, opacity);

    for (const face of faces) {
      if (!face.outer || input.marksOpacity === 0) continue;
      const key = `${face.owner.id}:${face.face}:${face.p}:${face.q}`;
      if (input.showFixed !== false && isFixed.has(key)) pendingOverlays.push({ color: FIXED_COLOR, faces: [face] });
      if (input.showLoads !== false && isLoaded.has(key)) pendingOverlays.push({ color: LOAD_COLOR, faces: [face] });
    }
  }

  const loadColor = (face: DrawnFace): THREE.Color => {
    const pressure = pressureOf.get(`${face.owner.id}:${face.face}:${face.p}:${face.q}`) ?? 0;
    return new THREE.Color(pressureColor(allPressures, pressure));
  };

  // clamped and pressed faces: one translucent set per colour
  for (const color of [FIXED_COLOR, LOAD_COLOR]) {
    const faces = pendingOverlays.filter(o => o.color === color).flatMap(o => o.faces);
    if (faces.length === 0) continue;
    const overlay = new THREE.Mesh(
      faceGeometry(faces, face => (color === LOAD_COLOR ? loadColor(face) : new THREE.Color(color)), false, false),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: input.marksOpacity ?? OVERLAY_OPACITY, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    );
    root.add(overlay);
  }

  if (lines.length > 0) {
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    if (displaced) deformables.push(deformable(buffer, lines, movedLines));
    const edges = new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
    edges.userData['edges'] = true;
    root.add(edges);
  }

  // the displacement vectors: arrows at the nodes, shown or hidden without a rebuild (userData.vectors)
  const arrows = result ? buildDisplacementArrows(result, rampColor) : null;
  if (arrows) {
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(arrows.base, 3));
    buffer.setAttribute('color', new THREE.Float32BufferAttribute(arrows.colors, 3));
    deformables.push(deformable(buffer, arrows.base, arrows.moved));
    const vectors = new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ vertexColors: true }));
    vectors.userData['vectors'] = true;
    vectors.visible = input.vectors !== false;
    root.add(vectors);
  }

  // what a click would act on is drawn into the view without rebuilding it
  let highlight: THREE.Object3D | null = null;
  const setHighlight = (group: THREE.Object3D | null) => {
    if (highlight) {
      root.remove(highlight);
      disposeObject(highlight);
    }
    highlight = group;
    if (group) root.add(group);
  };

  // a moved vertex invalidates the bounds; nothing here is culled by them
  root.traverse(o => (o.frustumCulled = false));

  const view: MeshView = {
    root, pickables, nodeMeshes: new Map(), setHighlight,
    setDeformation: scale => applyDeformation(deformables, scale),
    setColorRange: max => applyColorRange(deformables, max)
  };
  view.setDeformation?.(input.deformationScale);
  return view;
}

export function deformable(geometry: THREE.BufferGeometry, base: number[], moved: number[], values?: number[], light?: Float32Array): Deformable {
  const displacement = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) displacement[i] = moved[i] - base[i];
  return { geometry, base: Float32Array.from(base), displacement, values: values ? Float32Array.from(values) : undefined, light };
}

// Every vertex to base + scale * displacement - one pass over each buffer, no allocation.
export function applyDeformation(deformables: readonly Deformable[], scale: number): void {
  for (const d of deformables) {
    const position = d.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = position.array as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = d.base[i] + scale * d.displacement[i];
    position.needsUpdate = true;
    d.geometry.boundingSphere = null;
    d.geometry.boundingBox = null;
  }
}

// The colours of the field surfaces for a new top of the ramp (values above it get the last colour).
export function applyColorRange(deformables: readonly Deformable[], max: number): void {
  for (const d of deformables) {
    if (!d.values || !d.light) continue;
    const color = d.geometry.getAttribute('color') as THREE.BufferAttribute;
    const out = color.array as Float32Array;
    for (let i = 0; i < d.values.length; i++) {
      const t = max > 0 ? Math.min(1, Math.max(0, d.values[i] / max)) : 0;
      const [r, g, b] = RAMP_TABLE[Math.round(t * RAMP_STEPS)];
      out[3 * i] = r * d.light[i];
      out[3 * i + 1] = g * d.light[i];
      out[3 * i + 2] = b * d.light[i];
    }
    color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the highlight

export interface HighlightTargets {
  // small faces that a load or a clamp would mark (a whole side of a cube when p and q are absent)
  readonly faces: readonly SolverFaceDto[];
  // small elements that a material would be given to
  readonly elements: readonly { hex: number; ex: number; ey: number; ez: number }[];
  // the small face that was pointed at
  readonly pointed: PickedFace | null;
}

// A group that shows what a click would act on: the small faces to mark in yellow, or the outlines of the elements
// that would get a material. Built from the same geometry as the view, so it follows a deformed body too.
export function buildHighlight(input: SolverViewInput, targets: HighlightTargets, limit = 400): THREE.Group {
  const { state, setup, result, field } = input;
  const divisions = (result ? result.divisions : (setup?.divisions ?? [1, 1, 1])) as [number, number, number];
  const geometry = new SolverGeometry(state, divisions, result, result ? input.deformationScale : 0, field);
  const hexById = new Map(state.hexes.map(h => [h.id, h]));
  const group = new THREE.Group();
  const lines: number[] = [];

  const quads: number[] = [];
  const quadIndices: number[] = [];
  const resolution = faceResolution(geometry.counts);
  const addQuad = (hex: MeshHexDto, axis: number, t: number, p: number, q: number) => {
    const small = geometry.smallFace(hex, axis, t, p, q);
    // the same smooth surface as the material underneath, so the highlight reads as a coat laid over it
    appendSurface(quads, quadIndices, small, resolution);
    for (const [a, m, b] of FACE_EDGES) pushEdge(lines, small.positions[a], small.positions[m], small.positions[b], 6);
  };

  let used = 0;
  for (const target of targets.faces) {
    const hex = hexById.get(target.hex);
    if (!hex) continue;
    const axis = target.face.charCodeAt(0) - 'X'.charCodeAt(0);
    const t = target.face.endsWith('Plus') ? geometry.counts[axis] : 0;
    const [t0, t1] = [0, 1, 2].filter(d => d !== axis);
    const cells = target.p !== undefined && target.q !== undefined
      ? [[target.p, target.q]]
      : Array.from({ length: geometry.counts[t0] * geometry.counts[t1] }, (_, i) => [Math.floor(i / geometry.counts[t1]), i % geometry.counts[t1]]);
    for (const [p, q] of cells) {
      if (used++ >= limit) break;
      addQuad(hex, axis, t, p, q);
    }
  }
  for (const element of targets.elements) {
    if (used++ >= limit) break;
    const hex = hexById.get(element.hex);
    if (hex) lines.push(...geometry.elementEdges(hex, element.ex, element.ey, element.ez, 4));
  }
  if (targets.pointed && targets.pointed.p !== undefined && targets.pointed.q !== undefined) {
    const hex = hexById.get(targets.pointed.hex);
    if (hex) {
      const axis = targets.pointed.face.charCodeAt(0) - 'X'.charCodeAt(0);
      // the pointed small face on its own plane: the face of the element behind it
      const element = targets.pointed.element ?? [0, 0, 0];
      const t = targets.pointed.face.endsWith('Plus') ? element[axis] + 1 : element[axis];
      addQuad(hex, axis, t, targets.pointed.p, targets.pointed.q);
    }
  }

  if (quads.length > 0) {
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(quads, 3));
    buffer.setIndex(quadIndices);
    group.add(new THREE.Mesh(buffer, new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR, transparent: true, opacity: 0.45, depthWrite: false, depthTest: false, side: THREE.DoubleSide })));
  }
  if (lines.length > 0) {
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    group.add(new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, depthTest: false })));
  }
  group.renderOrder = 10;
  group.traverse(o => (o.renderOrder = 10));
  return group;
}

export function disposeObject(object: THREE.Object3D): void {
  object.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose());
    }
  });
}
