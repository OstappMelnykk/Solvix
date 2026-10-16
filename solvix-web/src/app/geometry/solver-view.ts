import * as THREE from 'three';
import { HexFaceName, MeshHexDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { QualityGradeName, SolverFaceDto, SolverQualityDto, SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { createDepthFade } from '../rendering/depth-fade';
import { markForWeightedOit } from '../rendering/weighted-oit';
import { buildDisplacementArrows } from './displacement-arrows';
import { QualityMetric, Result, measuredGrade, resultOf } from './quality-grading';
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
  readonly showLabels?: boolean;
  // When given, the small elements are coloured by their quality grade instead of by material.
  readonly quality?: SolverQualityDto | null;
  // What the quality colours show: the overall grade (default) or the grade of one measure.
  readonly qualityMetric?: QualityMetric;
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
  // Quality only: draw just the elements the chosen measure does not grade excellent, so the bad ones inside the body
  // stand free of the good ones around them.
  readonly onlyBad?: boolean;
  // A cut through the body: the elements whose centre lies on the other side of the plane (the real coordinate `axis`
  // equal to `at`) are not drawn, so the cut shows what is inside. `keep` is the side that stays.
  readonly section?: SectionCut;
  // Draw the dark edges of the small elements (default yes); the Quality World leaves them out when the Real World's own lines and nodes are laid over the faces.
  readonly edges?: boolean;
}

export interface SectionCut {
  readonly axis: 0 | 1 | 2;
  readonly at: number;
  readonly keep: 'above' | 'below';
}

const EDGE_SEGMENTS = 8;
const EDGE_COLOR = 0x1a1d23;
// the edges of a quality view: pale, like the Real World's, so they read on the dark scene
const QUALITY_EDGE_COLOR = 0xd5d9e0;
const FIXED_COLOR = 0x3388ff;
const LOAD_COLOR = 0x44ff44;
// One colour for the loads, in tones: the weaker the pressure, the paler the green; the strongest is the full one.
export function pressureColor(all: readonly number[], pressure: number): number {
  const distinct = Array.from(new Set(all.map(Math.abs))).sort((a, b) => a - b);
  if (distinct.length <= 1) return LOAD_COLOR;
  const rank = Math.max(0, distinct.indexOf(Math.abs(pressure)));
  const tone = 0.3 + 0.7 * (rank / (distinct.length - 1));
  return new THREE.Color(LOAD_COLOR).multiplyScalar(tone).getHex();
}
const HIGHLIGHT_COLOR = 0xffe14d;
const OVERLAY_OPACITY = 0.62;
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();

// Blue -> cyan -> green -> yellow -> red.
const RAMP: readonly THREE.Color[] = [0x2b3cc4, 0x2bb5d6, 0x3fc46a, 0xf0d43a, 0xe4572e].map(hex => new THREE.Color(hex));

// Colour of a value in [0, 1] on the ramp (values outside are clamped).
export function rampColor(t: number): THREE.Color {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return RAMP[i].clone().lerp(RAMP[i + 1], x - i);
}

const RAMP_STEPS = 256;
const RAMP_TABLE: readonly (readonly [number, number, number])[] = Array.from({ length: RAMP_STEPS + 1 }, (_, i) => {
  const c = rampColor(i / RAMP_STEPS);
  return [c.r, c.g, c.b] as const;
});

// A geometry that moves with the deformation: its vertices are base + scale * displacement (the surface is linear in
// the nodes, so the displacement of a vertex is fixed once and any scale is a single pass over a buffer), and its
// colours can follow a new range of the field without rebuilding anything.
interface Deformable {
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
export function materialColor(name: string): THREE.Color {
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

interface SmallFace {
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

// Everything that lies in the plane of a cut (the cut faces, the caps, the lines and dots on them, the sheet of the plane) is at
// the same depth, and with the logarithmic depth buffer the canvas uses (which ignores the polygon offset) such things fight
// for the pixel. So the lines, the dots and the sheet are moved a hair towards the viewer (towards the side that was cut away)
// and the caps a hair into the body: each layer has a depth of its own. `by` is in the units of the body.
export function shiftAlong(values: readonly number[], axis: 0 | 1 | 2, by: number): number[] {
  const out = values.slice();
  for (let i = axis; i < out.length; i += 3) out[i] += by;
  return out;
}

// A face that lies exactly in the plane of a cut belongs to the kept side, however the float32 rounding of its coordinates
// falls: the plane is moved this far out to the removed side.
const planeSlack = (cut: SectionCut): number => 2e-6 * (1 + Math.abs(cut.at));

// Cuts the triangles of a mesh by the plane of a section, keeping what is on the side that stays; a triangle the plane
// runs through is cut (the kept part of it is one or two triangles, the colours interpolated). Also returns, for each
// triangle that is left, the face it came from (so a click can still be traced back).
export function clipMeshToPlane(source: THREE.BufferGeometry, trianglesPerFace: number, cut: SectionCut): { geometry: THREE.BufferGeometry; faceOfTriangle: number[] } {
  const position = source.getAttribute('position');
  const color = source.getAttribute('color');
  const index = source.getIndex()!;
  const sign = cut.keep === 'above' ? 1 : -1;
  const slack = planeSlack(cut);
  const outPositions: number[] = [];
  const outColors: number[] = [];
  const faceOfTriangle: number[] = [];
  const vertex = (i: number) => ({
    p: [position.getX(i), position.getY(i), position.getZ(i)] as const,
    c: [color.getX(i), color.getY(i), color.getZ(i)] as const,
    d: sign * (alongOf(cut.axis, position.getX(i), position.getY(i), position.getZ(i)) - cut.at) + slack
  });
  type Vertex = ReturnType<typeof vertex>;
  const between = (a: Vertex, b: Vertex): Vertex => {
    const t = a.d / (a.d - b.d);
    return {
      p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t] as const,
      c: [a.c[0] + (b.c[0] - a.c[0]) * t, a.c[1] + (b.c[1] - a.c[1]) * t, a.c[2] + (b.c[2] - a.c[2]) * t] as const,
      d: 0
    };
  };
  const emit = (face: number, ...corners: Vertex[]) => {
    for (const v of corners) {
      outPositions.push(...v.p);
      outColors.push(...v.c);
    }
    faceOfTriangle.push(face);
  };
  for (let t = 0; t < index.count / 3; t++) {
    const face = Math.floor(t / trianglesPerFace);
    const corners = [vertex(index.getX(3 * t)), vertex(index.getX(3 * t + 1)), vertex(index.getX(3 * t + 2))];
    // the polygon that stays: walk the three sides and keep what is on the right side of the plane
    const polygon: Vertex[] = [];
    for (let i = 0; i < 3; i++) {
      const a = corners[i], b = corners[(i + 1) % 3];
      if (a.d >= 0) polygon.push(a);
      if ((a.d >= 0) !== (b.d >= 0)) polygon.push(between(a, b));
    }
    for (let i = 1; i + 1 < polygon.length; i++) emit(face, polygon[0], polygon[i], polygon[i + 1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(outPositions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(outColors, 3));
  geometry.setIndex(Array.from({ length: outPositions.length / 3 }, (_, i) => i));
  return { geometry, faceOfTriangle };
}

// The line segments (pairs of points, 6 numbers each) cut by the plane: the part on the kept side only.
export function clipSegmentsToPlane(segments: readonly number[], cut: SectionCut): number[] {
  const sign = cut.keep === 'above' ? 1 : -1;
  const slack = planeSlack(cut);
  const out: number[] = [];
  for (let i = 0; i + 5 < segments.length; i += 6) {
    const a = [segments[i], segments[i + 1], segments[i + 2]], b = [segments[i + 3], segments[i + 4], segments[i + 5]];
    const da = sign * (alongOf(cut.axis, a[0], a[1], a[2]) - cut.at) + slack, db = sign * (alongOf(cut.axis, b[0], b[1], b[2]) - cut.at) + slack;
    if (da < 0 && db < 0) continue;
    if (da >= 0 && db >= 0) { out.push(...a, ...b); continue; }
    const t = da / (da - db);
    const cutPoint = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    if (da >= 0) out.push(...a, ...cutPoint);
    else out.push(...cutPoint, ...b);
  }
  return out;
}

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

interface DrawnFace {
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
function facePoint(face: SmallFace, u: number, v: number): THREE.Vector3 {
  const point = new THREE.Vector3();
  for (let k = 0; k < 8; k++) point.addScaledVector(face.positions[k], faceShape(k, u, v));
  return point;
}

// A label with the pressure, drawn on the face: a sprite that always looks at the camera.
function pressureLabel(text: string, position: THREE.Vector3, height: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = 'rgba(10, 30, 10, 0.78)';
    context.fillRect(0, 0, 256, 96);
    context.strokeStyle = '#44ff44';
    context.lineWidth = 4;
    context.strokeRect(2, 2, 252, 92);
    context.fillStyle = '#d6ffd6';
    context.font = 'bold 44px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 128, 50);
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }));
  sprite.position.copy(position);
  sprite.scale.set(height * (256 / 96), height, 1);
  sprite.renderOrder = 10;
  sprite.userData['pressureLabel'] = true;
  return sprite;
}

function appendSurface(positions: number[], indices: number[], face: SmallFace, resolution: number, onVertex?: (u: number, v: number, value: number) => void): void {
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
  // the depth layers of a cut (see shiftAlong): one step is a thousandth of the body's size
  const layer = (() => {
    if (!input.section) return 0;
    let low = Infinity, high = -Infinity;
    for (const n of state.nodes) for (const c of [n.x, n.y, n.z]) { low = Math.min(low, c); high = Math.max(high, c); }
    return Math.max(1e-9, (high - low) * 1e-3) * (input.section.keep === 'above' ? -1 : 1);       // towards the viewer, on the removed side
  })();

  const values = result && !input.quality ? fieldValues(result, field) : null;
  const range: FieldRange = values ? { min: 0, max: input.colorMax && input.colorMax > 0 ? input.colorMax : fieldRange(values).max } : { min: 0, max: 0 };
  const span = range.max - range.min;

  // the elements the server flagged; any other small element is excellent
  const qualityColors = input.quality
    ? new Map(input.quality.flagged.map(e => [`${e.hex}:${e.ex}:${e.ey}:${e.ez}`, measuredGrade(e, input.qualityMetric ?? 'grade', input.quality!.limits)]))
    : null;
  // a flagged element that the chosen measure does not grade excellent
  const isBad = (hex: number, ex: number, ey: number, ez: number): boolean => (qualityColors?.get(`${hex}:${ex}:${ey}:${ez}`) ?? 'excellent') !== 'excellent';
  const seeThrough = qualityColors !== null && opacity < 1;
  // the quality view's lines and dots are lifted a hair towards the camera, so the ones lying ON a face win over it (no fade: the body is not see-through here)
  const lift = <T extends THREE.Material>(material: T): T => {
    if (qualityColors) createDepthFade(new THREE.Vector3(), 1, 1).patch(material);
    return material;
  };
  const hexById = new Map(state.hexes.map(h => [h.id, h]));
  const links = new Map<string, { hex: number; face: HexFaceName }>();
  for (const f of state.faces) if (f.status === 'Linked' && f.otherHex !== null && f.otherFace !== null) links.set(`${f.hex}:${f.face}`, { hex: f.otherHex, face: f.otherFace });

  const overrides = new Map((setup?.elementMaterials ?? []).map(m => [`${m.hex}:${m.ex}:${m.ey}:${m.ez}`, m.material]));
  const materialOf = (hex: number, ex: number, ey: number, ez: number): string =>
    overrides.get(`${hex}:${ex}:${ey}:${ez}`) ?? setup?.hexMaterials[hex] ?? setup?.defaultMaterial ?? 'default';
  // an element is drawn unless its material is hidden, it is cut away, or only the bad ones are wanted and it is not
  const shownCache = new Map<string, boolean>();
  const visible = (hex: number, ex: number, ey: number, ez: number): boolean => {
    const key = `${hex}:${ex}:${ey}:${ez}`;
    let shown = shownCache.get(key);
    if (shown === undefined) {
      shown = !hidden.has(materialOf(hex, ex, ey, ez));
      if (shown && input.onlyBad && qualityColors && !isBad(hex, ex, ey, ez)) shown = false;
      const cut = input.section;
      if (shown && cut) {
        // an element stays while any part of it is on the kept side: the ones the plane runs through are cut by it
        const { min, max } = geometry.elementExtent(hexById.get(hex)!, ex, ey, ez, cut.axis);
        const slack = planeSlack(cut);
        // one that only touches the plane from the far side is gone: its faces at the plane are then the cut itself
        shown = cut.keep === 'above' ? max > cut.at + slack : min < cut.at - slack;
      }
      shownCache.set(key, shown);
    }
    return shown;
  };

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
            // with the body see-through, the faces around a bad element are drawn even inside the body, so it can be seen
            const lowBad = lowVisible && isBad(low!.hex.id, ...low!.element), highBad = highVisible && isBad(high!.hex.id, ...high!.element);
            const keep = lowVisible !== highVisible || (lowVisible && highVisible && (input.showInner === true || (seeThrough && (lowBad || highBad))));
            if (!keep) continue;
            const ownerIsHigh = highVisible && !(lowVisible && lowBad && !highBad);   // with both visible: the high side, but the bad one wins
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
      values ? rampColor(span > 0 ? (value - range.min) / span : 0) : qualityColors ? new THREE.Color(RESULT_COLORS[resultOf(qualityColors.get(`${face.owner.id}:${face.element.join(':')}`) ?? 'excellent')]) : materialColor(materialOf(face.owner.id, ...face.element));
    const addBody = (subset: readonly DrawnFace[], subsetOpacity: number): void => {
    const subsetSolid = subsetOpacity >= 1;
    // The quality view is lit and matt like the Real World's body (the colours are the grades); the other views keep a light baked into their colours.
    const lit = qualityColors !== null;
    const material: THREE.Material = lit
      // see-through, it blends with every face behind it (no depth test), as the Real World's faces do - one tone whatever the order
      ? new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !subsetSolid, opacity: subsetOpacity, depthWrite: subsetSolid, depthTest: subsetSolid })
      : new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !subsetSolid, opacity: subsetOpacity, depthWrite: subsetSolid });
    // see-through: handed to the order-independent transparency pass, which blends without sorting
    if (!lit) markForWeightedOit(material);
    let bodyGeometry = faceGeometry(subset, colorOf, !lit, values !== null);
    if (lit) bodyGeometry.computeVertexNormals();
    let faceOfTriangle: number[] | null = null;
    if (input.section) {
      // the plane of a section cuts the faces it runs through: what is on the kept side stays, to the very plane
      const clipped = clipMeshToPlane(bodyGeometry, triangles, input.section);
      bodyGeometry.dispose();
      bodyGeometry = clipped.geometry;
      faceOfTriangle = clipped.faceOfTriangle;
      if (lit) bodyGeometry.computeVertexNormals();             // the cut made a new geometry: a lit face needs its normals again
    }
    const mesh = new THREE.Mesh(bodyGeometry, material);
    // a click lands on a triangle; its small face is the triangle's number divided by the triangles of one small face
    // (after a cut, the face each triangle came from was kept)
    mesh.userData['resolvePick'] = (triangle: number): PickedFace | null => {
      const face = subset[faceOfTriangle ? (faceOfTriangle[triangle] ?? -1) : Math.floor(triangle / triangles)];
      return face
        ? { kind: 'face', hex: face.owner.id, face: face.face, p: face.p, q: face.q, element: face.element, inner: !face.outer }
        : null;
    };
    mesh.userData['pick'] = mesh.userData['resolvePick'](0);
    if (lit) mesh.renderOrder = 1;
    // a translucent outside also writes depth, invisibly, so the lines laid over it are full strength only where nothing of the body is in front of them
    if (lit && !subsetSolid && (input.section || subset.some(f => f.outer))) {
      const outside = input.section || subset.every(f => f.outer) ? bodyGeometry : faceGeometry(subset.filter(f => f.outer), colorOf, false);
      const depthOnly = new THREE.Mesh(outside, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }));
      depthOnly.renderOrder = 0;
      root.add(depthOnly);
    }
    root.add(mesh);
    pickables.push(mesh);
    };
    // one opacity for every face, so the whole body is one tone (the faces round a bad element inside are drawn too, so it can be seen)
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

  // the pressure written on the pressed faces: one label per cube side and pressure (when the body is not deformed)
  if (!displaced && input.showLabels !== false && input.showLoads !== false && (input.marksOpacity ?? 1) !== 0) {
    const groups = new Map<string, { text: string; points: THREE.Vector3[]; normals: THREE.Vector3[]; area: number }>();
    const everyPoint: THREE.Vector3[] = [];
    for (const faces of drawn.values()) {
      for (const face of faces) {
        if (!face.outer) continue;
        const key = `${face.owner.id}:${face.face}:${face.p}:${face.q}`;
        const pressure = pressureOf.get(key);
        if (pressure === undefined) continue;
        const small = geometry.smallFace(face.drawer, face.axis, face.t, face.p, face.q);
        const centre = facePoint(small, 0, 0);
        const spanned = facePoint(small, 1, 0).sub(facePoint(small, -1, 0)).cross(facePoint(small, 0, 1).sub(facePoint(small, 0, -1)));
        const area = spanned.length();
        const normal = spanned.normalize();
        const group = `${face.owner.id}:${face.face}:${pressure}`;
        const entry = groups.get(group) ?? { text: `${Number((pressure / 1e6).toPrecision(3))} МПа`, points: [], normals: [], area: 0 };
        entry.points.push(centre);
        entry.normals.push(normal);
        entry.area += area;
        groups.set(group, entry);
        everyPoint.push(centre);
      }
    }
    if (everyPoint.length > 0) {
      const box = new THREE.Box3().setFromPoints(everyPoint);
      const body = new THREE.Vector3();
      box.getCenter(body);
      const bodySize = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6);
      for (const entry of groups.values()) {
        // the label is as big as the surface it speaks of: its height is a sixth of the side of a square of that area
        const height = Math.min(bodySize * 0.15, Math.max(bodySize * 0.006, Math.sqrt(entry.area) / 6));
        const centre = entry.points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(entry.points.length);
        const normal = entry.normals.reduce((sum, n) => sum.add(n), new THREE.Vector3()).normalize();
        if (normal.dot(centre.clone().sub(body)) < 0) normal.negate();
        root.add(pressureLabel(entry.text, centre.add(normal.multiplyScalar(height * 0.6)), height));
      }
    }
  }

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

  if (lines.length > 0 && input.edges !== false) {
    const buffer = new THREE.BufferGeometry();
    const shownLines = input.section ? clipSegmentsToPlane(lines, input.section) : lines;
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(input.section ? shiftAlong(shownLines, input.section.axis, layer) : shownLines, 3));
    if (displaced) deformables.push(deformable(buffer, lines, movedLines));
    const edges = new THREE.LineSegments(buffer, lift(new THREE.LineBasicMaterial({ color: qualityColors ? QUALITY_EDGE_COLOR : EDGE_COLOR })));
    edges.userData['edges'] = true;
    root.add(edges);
  }

  // only the bad elements: their vertices are drawn like the cut's (cube corners white, midpoints yellow), so they can be seen and counted
  if (qualityColors && input.onlyBad && !input.section) {
    const cornerKeys = new Set<string>();
    const found = new Map<string, { at: THREE.Vector3; corner: boolean }>();
    const keyOf = (v: THREE.Vector3) => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
    for (const hexNodeId of state.hexes.flatMap(h => h.nodeIds.slice(0, 8))) {
      const n = state.nodes.find(x => x.id === hexNodeId);
      if (n) cornerKeys.add(keyOf(new THREE.Vector3(n.x, n.y, n.z)));
    }
    for (const faces of drawn.values()) {
      for (const face of faces) {
        const small = geometry.smallFace(face.drawer, face.axis, face.t, face.p, face.q);
        small.positions.forEach((v: THREE.Vector3) => {
          const key = keyOf(v);
          if (!found.has(key)) found.set(key, { at: v, corner: cornerKeys.has(key) });
        });
      }
    }
    for (const [wanted, colour, size] of [[true, 0xffffff, 7], [false, 0xf0b429, 5]] as const) {
      const points = Array.from(found.values()).filter(f => f.corner === wanted);
      if (points.length === 0) continue;
      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap(f => [f.at.x, f.at.y, f.at.z]), 3));
      root.add(new THREE.Points(pointGeometry, lift(new THREE.PointsMaterial({ color: colour, size, sizeAttenuation: false }))));
    }
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

  // the cut itself: for every element the plane runs through, the polygon in which it cuts it, in the colour of the element
  if (input.section) {
    const cut = input.section;
    const capPositions: number[] = [];
    const capColors: number[] = [];
    const stats = { straddlers: 0, withoutOutline: 0, openChains: 0 };       // for checking the cut, not for drawing
    const outline: number[] = [];                  // the edge of every cap, drawn dark over it
    const interior: number[] = [];                 // the edges of the elements inside the body, so its structure shows
    const wantInterior = state.hexes.length * counts[0] * counts[1] * counts[2] <= 8000;
    const resolutionCap = faceResolution(counts);
    for (const hex of state.hexes) {
      for (let ex = 0; ex < counts[0]; ex++)
        for (let ey = 0; ey < counts[1]; ey++)
          for (let ez = 0; ez < counts[2]; ez++) {
            if (!visible(hex.id, ex, ey, ez)) continue;
            const { min, max } = geometry.elementExtent(hex, ex, ey, ez, cut.axis);
            if (wantInterior) interior.push(...clipSegmentsToPlane(geometry.elementEdges(hex, ex, ey, ez, 3), cut));
            const slack = planeSlack(cut);
            if (!(min < cut.at - slack && max > cut.at + slack)) continue;
            const e = [ex, ey, ez];
            const sixFaces: { positions: number[]; indices: number[] }[] = [];
            for (let axis = 0; axis < 3; axis++) {
              const [t0, t1] = [0, 1, 2].filter(d => d !== axis);
              for (const t of [e[axis], e[axis] + 1]) {
                const positions: number[] = [];
                const indices: number[] = [];
                appendSurface(positions, indices, geometry.smallFace(hex, axis, t, e[t0], e[t1]), resolutionCap);
                sixFaces.push({ positions, indices });
              }
            }
            const report = { open: 0 };
            const loops = elementSectionLoops(sixFaces, cut, report);
            stats.straddlers++;
            stats.openChains += report.open;
            if (loops.length === 0) { stats.withoutOutline++; continue; }
            const rgb = new THREE.Color(
              qualityColors
                ? RESULT_COLORS[resultOf(qualityColors.get(`${hex.id}:${ex}:${ey}:${ez}`) ?? 'excellent')]
                : materialColor(materialOf(hex.id, ex, ey, ez))
            );
            for (const loop of loops) {
              for (const [i, j, k] of triangulateLoop(loop, cut.axis)) {
                for (const p of [loop[i], loop[j], loop[k]]) {
                  capPositions.push(p.x, p.y, p.z);
                  capColors.push(rgb.r, rgb.g, rgb.b);
                }
              }
              for (let i = 0; i < loop.length; i++) {
                const a = loop[i], b = loop[(i + 1) % loop.length];
                outline.push(a.x, a.y, a.z, b.x, b.y, b.z);
              }
            }
          }
    }
    root.userData['sectionStats'] = stats;
    if (capPositions.length > 0) {
      const capGeometry = new THREE.BufferGeometry();
      capGeometry.setAttribute('position', new THREE.Float32BufferAttribute(shiftAlong(capPositions, cut.axis, -layer), 3));
      capGeometry.setAttribute('color', new THREE.Float32BufferAttribute(capColors, 3));
      // in the quality view the cut is lit like the faces around it (its normal is the plane's)
      const capMaterial: THREE.MeshBasicMaterial | THREE.MeshLambertMaterial = qualityColors
        ? new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !solid, opacity, depthWrite: solid })
        : new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !solid, opacity, depthWrite: solid });
      if (qualityColors) {
        // the cut looks to the open side. A two-sided material turns the normal of a triangle seen from behind, so a triangle wound the other way gets the opposite normal.
        const open = cut.keep === 'below' ? 1 : -1;
        const normals: number[] = [];
        const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
        for (let i = 0; i < capPositions.length; i += 9) {
          pa.fromArray(capPositions, i); pb.fromArray(capPositions, i + 3); pc.fromArray(capPositions, i + 6);
          const wound = [0, 0, 0];
          wound[cut.axis] = pb.sub(pa).cross(pc.sub(pa)).getComponent(cut.axis) >= 0 ? open : -open;
          for (let k = 0; k < 3; k++) normals.push(wound[0], wound[1], wound[2]);
        }
        capGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      } else markForWeightedOit(capMaterial);
      capMaterial.polygonOffset = true;               // behind its own outline, which lies in the same plane
      capMaterial.polygonOffsetFactor = 1;
      capMaterial.polygonOffsetUnits = 1;
      const cap = new THREE.Mesh(capGeometry, capMaterial);
      cap.userData['sectionCap'] = true;
      root.add(cap);
    }
    // the structure of the body that is left: where the elements meet (their edges), and the vertices of the cubes
    const structure = [...interior, ...outline];
    if (structure.length > 0) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(shiftAlong(structure, cut.axis, layer), 3));
      const inside = new THREE.LineSegments(lineGeometry, lift(new THREE.LineBasicMaterial({ color: qualityColors ? QUALITY_EDGE_COLOR : EDGE_COLOR })));
      inside.userData['sectionStructure'] = true;
      root.add(inside);
    }
    const kept = (n: { x: number; y: number; z: number }) => {
      const d = alongOf(cut.axis, n.x, n.y, n.z) - cut.at;
      return cut.keep === 'above' ? d >= -planeSlack(cut) : d <= planeSlack(cut);
    };
    const cornerNodes = new Set(state.hexes.flatMap(h => h.nodeIds.slice(0, 8)));
    for (const [wanted, colour, size] of [[true, 0xffffff, 7], [false, 0xf0b429, 5]] as const) {
      const points = state.nodes.filter(n => cornerNodes.has(n.id) === wanted && kept(n));
      if (points.length === 0) continue;
      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(shiftAlong(points.flatMap(n => [n.x, n.y, n.z]), cut.axis, 2 * layer), 3));
      const dots = new THREE.Points(pointGeometry, lift(new THREE.PointsMaterial({ color: colour, size, sizeAttenuation: false, depthTest: true })));
      dots.userData['sectionNodes'] = wanted ? 'corners' : 'midpoints';
      root.add(dots);
    }
  }

  // the plane of the cut, drawn as a pale sheet with an outline, so it is plain where it passes through the body
  if (input.section) {
    // the sheet lies behind the cut itself (which is shifted by one layer into the body), so it never tints the cut seen from the open side
    const plane = sectionPlane(state, { ...input.section, at: input.section.at - 2 * layer });
    plane.userData['sectionPlane'] = true;
    root.add(plane);
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

function deformable(geometry: THREE.BufferGeometry, base: number[], moved: number[], values?: number[], light?: Float32Array): Deformable {
  const displacement = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) displacement[i] = moved[i] - base[i];
  return { geometry, base: Float32Array.from(base), displacement, values: values ? Float32Array.from(values) : undefined, light };
}

// Every vertex to base + scale * displacement - one pass over each buffer, no allocation.
function applyDeformation(deformables: readonly Deformable[], scale: number): void {
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
function applyColorRange(deformables: readonly Deformable[], max: number): void {
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

function disposeObject(object: THREE.Object3D): void {
  object.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose());
    }
  });
}
