import * as THREE from 'three';
import { HexFaceName, MeshHexDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { LOCAL_COORDS, MeshView, PickedFace, faceAxis, faceSign, mapHex } from './mesh-editor-view';

// The Solver World's drawing of a body, the way the solver's own viewer shows its mesh: every cube cut into
// nx*ny*nz small elements, only the outer faces drawn (each as the small faces of the outer small elements, with
// their curved edges), coloured by the material while setting up or by a field of the solution after a solve;
// clamped faces in blue, pressed faces in green, the body optionally drawn deformed and see-through.

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
  readonly selectedHexes: readonly number[];
}

const EDGE_SEGMENTS = 8;
const EDGE_COLOR = 0x20242b;
const FIXED_COLOR = 0x3388ff;
const LOAD_COLOR = 0x44ff44;
const OVERLAY_OPACITY = 0.6;
const SELECTED_HEX_MIX = 0.4;
const SELECTED_HEX_COLOR = new THREE.Color(0x39c5f2);

// Blue -> cyan -> green -> yellow -> red.
const RAMP: readonly THREE.Color[] = [0x2b3cc4, 0x2bb5d6, 0x3fc46a, 0xf0d43a, 0xe4572e].map(hex => new THREE.Color(hex));

// Colour of a value in [0, 1] on the ramp (values outside are clamped).
export function rampColor(t: number): THREE.Color {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return RAMP[i].clone().lerp(RAMP[i + 1], x - i);
}

// A stable colour per material name, so the same material looks the same everywhere.
export function materialColor(name: string): THREE.Color {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.45, 0.58);
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

function faceShape(i: number, u: number, v: number): number {
  const [ui, vi] = FACE_NODES[i];
  if (ui !== 0 && vi !== 0) return 0.25 * (1 + u * ui) * (1 + v * vi) * (u * ui + v * vi - 1);
  if (ui === 0) return 0.5 * (1 - u * u) * (1 + v * vi);
  return 0.5 * (1 + u * ui) * (1 - v * v);
}

export function buildSolverView(input: SolverViewInput): MeshView {
  const { state, setup, result, field } = input;
  const root = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const nodes = new Map(state.nodes.map(n => [n.id, n]));
  const divisions = (result ? result.divisions : (setup?.divisions ?? [1, 1, 1])) as [number, number, number];
  const [nx, ny, nz] = divisions;
  const points = gridPoints(nx, ny, nz);
  const pointIndex = new Map(points.map((p, i) => [p.join(','), i]));
  const hexIndexInResult = new Map((result?.hexIds ?? []).map((id, i) => [id, i]));

  const values = result ? fieldValues(result, field) : null;
  const range: FieldRange = values ? { min: 0, max: fieldRange(values).max } : { min: 0, max: 0 };
  const span = range.max - range.min;
  const scale = result ? input.deformationScale : 0;
  const opacity = Math.min(1, Math.max(0.05, input.opacity));
  const solid = opacity >= 1;

  // undeformed + displacement of every grid point of a cube, computed once per cube
  interface CubeGrid {
    readonly position: (ix: number, iy: number, iz: number) => THREE.Vector3;
    readonly value: (ix: number, iy: number, iz: number) => number;
  }
  const gridOf = (hex: MeshHexDto): CubeGrid => {
    const slotPositions = LOCAL_COORDS.map((_, slot) => {
      const node = nodes.get(hex.nodeIds[slot])!;
      return new THREE.Vector3(node.x, node.y, node.z);
    });
    const resultIndex = hexIndexInResult.get(hex.id);
    const nodeAt = (ix: number, iy: number, iz: number): number | null =>
      result && resultIndex !== undefined ? result.gridNodes[resultIndex * points.length + pointIndex.get(`${ix},${iy},${iz}`)!] : null;
    return {
      position: (ix, iy, iz) => {
        const node = nodeAt(ix, iy, iz);
        if (node === null || !result) return mapHex(slotPositions, ix / nx - 1, iy / ny - 1, iz / nz - 1);
        const point = new THREE.Vector3(result.positions[3 * node], result.positions[3 * node + 1], result.positions[3 * node + 2]);
        return scale !== 0 ? point.add(new THREE.Vector3(result.ux[node], result.uy[node], result.uz[node]).multiplyScalar(scale)) : point;
      },
      value: (ix, iy, iz) => {
        const node = nodeAt(ix, iy, iz);
        return node === null || !values ? 0 : values[node];
      }
    };
  };

  const isFixed = new Set((setup?.fixed ?? []).map(f => `${f.hex}:${f.face}`));
  const isLoaded = new Set((setup?.loads ?? []).map(l => `${l.hex}:${l.face}`));
  const selected = new Set(input.selectedHexes);
  const hexById = new Map(state.hexes.map(h => [h.id, h]));
  const grids = new Map<number, CubeGrid>();
  const lines: number[] = [];

  // The small faces of one cube face: for each, its 8 grid points (positions, values).
  const smallFaces = (hex: MeshHexDto, face: HexFaceName) => {
    const grid = grids.get(hex.id) ?? (grids.set(hex.id, gridOf(hex)), grids.get(hex.id)!);
    const axis = faceAxis(face);
    const [t0, t1] = [0, 1, 2].filter(d => d !== axis);
    const counts = [nx, ny, nz];
    const fixedIndex = faceSign(face) > 0 ? 2 * counts[axis] : 0;
    const out: { positions: THREE.Vector3[]; values: number[] }[] = [];
    for (let p = 0; p < counts[t0]; p++) {
      for (let q = 0; q < counts[t1]; q++) {
        const positions: THREE.Vector3[] = [];
        const vals: number[] = [];
        for (const [u, v] of FACE_NODES) {
          const index = [0, 0, 0];
          index[axis] = fixedIndex;
          index[t0] = 2 * p + u + 1;
          index[t1] = 2 * q + v + 1;
          positions.push(grid.position(index[0], index[1], index[2]));
          vals.push(grid.value(index[0], index[1], index[2]));
        }
        out.push({ positions, values: vals });
      }
    }
    return out;
  };

  // One merged geometry for all small faces of a cube face, coloured by `colorAt(value)`.
  const resolution = Math.max(2, Math.ceil(8 / Math.max(nx, ny, nz)));
  const faceGeometry = (faces: { positions: THREE.Vector3[]; values: number[] }[], colorAt: (value: number) => THREE.Color): THREE.BufferGeometry => {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const stride = resolution + 1;
    for (const face of faces) {
      const base = positions.length / 3;
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
          const color = colorAt(value);
          colors.push(color.r, color.g, color.b);
        }
      }
      for (let iv = 0; iv < resolution; iv++) {
        for (let iu = 0; iu < resolution; iu++) {
          const a = base + iv * stride + iu;
          indices.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    return geometry;
  };

  for (const face of state.faces) {
    if (face.status === 'Linked') continue;                 // inside the body
    const hex = hexById.get(face.hex);
    if (!hex) continue;
    const faces = smallFaces(hex, face.face);

    // the edges of the small faces: curved, through corner - midpoint - corner
    for (const small of faces) {
      for (const [a, m, b] of FACE_EDGES) {
        let previous = small.positions[a];
        for (let i = 1; i <= EDGE_SEGMENTS; i++) {
          const t = (i / EDGE_SEGMENTS) * 2 - 1;
          const next = small.positions[a].clone().multiplyScalar((t * (t - 1)) / 2).addScaledVector(small.positions[m], 1 - t * t).addScaledVector(small.positions[b], (t * (t + 1)) / 2);
          lines.push(previous.x, previous.y, previous.z, next.x, next.y, next.z);
          previous = next;
        }
      }
    }

    const base = materialColor(setup?.hexMaterials[hex.id] ?? setup?.defaultMaterial ?? 'default');
    const baseColor = selected.has(hex.id) ? base.clone().lerp(SELECTED_HEX_COLOR, SELECTED_HEX_MIX) : base;
    const mesh = new THREE.Mesh(
      faceGeometry(faces, value => (values ? rampColor(span > 0 ? (value - range.min) / span : 0) : baseColor)),
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !solid, opacity, depthWrite: solid })
    );
    mesh.userData['pick'] = { kind: 'face', hex: hex.id, face: face.face } satisfies PickedFace;
    root.add(mesh);
    pickables.push(mesh);

    const key = `${hex.id}:${face.face}`;
    const overlay = (color: number) => {
      const quad = new THREE.Mesh(
        faceGeometry(faces, () => new THREE.Color(color)),
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: OVERLAY_OPACITY, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      );
      root.add(quad);
    };
    if (isFixed.has(key)) overlay(FIXED_COLOR);
    if (isLoaded.has(key)) overlay(LOAD_COLOR);
  }

  if (lines.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    root.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: !solid, opacity: solid ? 1 : Math.min(1, opacity + 0.3) })));
  }

  return { root, pickables, nodeMeshes: new Map() };
}
