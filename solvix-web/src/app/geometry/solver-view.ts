import * as THREE from 'three';
import { HexFaceName, MeshHexDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { LOCAL_COORDS, MeshView, PickedFace, faceAxis, faceSign, mapHex, shapeFunctions20 } from './mesh-editor-view';

// The Solver World's drawing of a body: only its outer faces, coloured by what the user is looking at - the
// material of each cube while setting up, or a field of the solution (von Mises stress, displacement) after a
// solve - with clamped faces in red, pressed faces in blue, and the body optionally drawn deformed.

export type SolverField = 'none' | 'vonMises' | 'displacement';

export interface SolverViewInput {
  readonly state: MeshStateDto;
  readonly setup: SolverSetupDto | null;
  readonly result: SolverResultDto | null;
  readonly field: SolverField;
  // Exaggeration of the displacements when the body is drawn deformed (0 = undeformed).
  readonly deformationScale: number;
  readonly selectedHexes: readonly number[];
  readonly selectedFace: { readonly hex: number; readonly face: HexFaceName } | null;
}

const FACE_GRID = 8;
const EDGE_SEGMENTS = 10;
const EDGE_COLOR = 0x20242b;
const FIXED_COLOR = 0xe05252;
const LOAD_COLOR = 0x39a6f2;
const PICKED_FACE_COLOR = 0xffe14d;
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

// The values of a field per solver node (aligned with result.nodeIds).
export function fieldValues(result: SolverResultDto, field: SolverField): number[] | null {
  if (field === 'none') return null;
  if (field === 'vonMises') return [...result.vonMises];
  return result.nodeIds.map((_, i) => Math.sqrt(result.ux[i] ** 2 + result.uy[i] ** 2 + result.uz[i] ** 2));
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

function faceGrid(
  axis: number,
  sign: number,
  slotPosition: (slot: number) => THREE.Vector3,
  valueOf: ((a: number, b: number, g: number) => number) | null,
  colorAt: (value: number | null) => THREE.Color
): THREE.BufferGeometry {
  const tangent = [0, 1, 2].filter(d => d !== axis);
  const positions: number[] = [];
  const colors: number[] = [];
  const slotPositions = LOCAL_COORDS.map((_, slot) => slotPosition(slot));
  for (let iv = 0; iv <= FACE_GRID; iv++) {
    for (let iu = 0; iu <= FACE_GRID; iu++) {
      const local = [0, 0, 0];
      local[axis] = sign;
      local[tangent[0]] = (iu / FACE_GRID) * 2 - 1;
      local[tangent[1]] = (iv / FACE_GRID) * 2 - 1;
      const point = mapHex(slotPositions, local[0], local[1], local[2]);
      positions.push(point.x, point.y, point.z);
      const color = colorAt(valueOf ? valueOf(local[0], local[1], local[2]) : null);
      colors.push(color.r, color.g, color.b);
    }
  }
  const indices: number[] = [];
  const stride = FACE_GRID + 1;
  for (let iv = 0; iv < FACE_GRID; iv++) {
    for (let iu = 0; iu < FACE_GRID; iu++) {
      const a = iv * stride + iu;
      indices.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

export function buildSolverView(input: SolverViewInput): MeshView {
  const { state, setup, result, field } = input;
  const root = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const nodes = new Map(state.nodes.map(n => [n.id, n]));

  // displacement of each node, by node id
  const displacement = new Map<number, THREE.Vector3>();
  const valueByNode = new Map<number, number>();
  let range: FieldRange = { min: 0, max: 0 };
  if (result) {
    result.nodeIds.forEach((id, i) => displacement.set(id, new THREE.Vector3(result.ux[i], result.uy[i], result.uz[i])));
    const values = fieldValues(result, field);
    if (values) {
      result.nodeIds.forEach((id, i) => valueByNode.set(id, values[i]));
      range = { min: 0, max: fieldRange(values).max };
    }
  }
  const scale = result ? input.deformationScale : 0;
  const slotPositionOf = (hex: MeshHexDto) => (slot: number) => {
    const node = nodes.get(hex.nodeIds[slot])!;
    const point = new THREE.Vector3(node.x, node.y, node.z);
    const u = displacement.get(node.id);
    return u && scale !== 0 ? point.addScaledVector(u, scale) : point;
  };
  const span = range.max - range.min;
  const showField = result !== null && field !== 'none' && valueByNode.size > 0;
  const hexById = new Map(state.hexes.map(h => [h.id, h]));

  // Curved edges of every cube (one set of lines).
  const lines: number[] = [];
  for (const hex of state.hexes) {
    const at = slotPositionOf(hex);
    const slotPoints = LOCAL_COORDS.map((_, slot) => at(slot));
    const edgePairs: readonly (readonly [number, number])[] = [
      [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]
    ];
    edgePairs.forEach(([a, b], k) => {
      const start = slotPoints[a];
      const mid = slotPoints[8 + k];
      const end = slotPoints[b];
      let previous = start;
      for (let i = 1; i <= EDGE_SEGMENTS; i++) {
        const t = (i / EDGE_SEGMENTS) * 2 - 1;
        const next = start.clone().multiplyScalar((t * (t - 1)) / 2).addScaledVector(mid, 1 - t * t).addScaledVector(end, (t * (t + 1)) / 2);
        lines.push(previous.x, previous.y, previous.z, next.x, next.y, next.z);
        previous = next;
      }
    });
  }
  if (lines.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    root.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: EDGE_COLOR })));
  }

  const isFixed = new Set((setup?.fixed ?? []).map(f => `${f.hex}:${f.face}`));
  const isLoaded = new Set((setup?.loads ?? []).map(l => `${l.hex}:${l.face}`));
  const selected = new Set(input.selectedHexes);

  for (const face of state.faces) {
    if (face.status === 'Linked') continue;                 // inside the body
    const hex = hexById.get(face.hex);
    if (!hex) continue;
    const axis = faceAxis(face.face);
    const sign = faceSign(face.face);
    const at = slotPositionOf(hex);
    const nodeValues = hex.nodeIds.map(id => valueByNode.get(id) ?? 0);
    const base = materialColor(setup?.hexMaterials[hex.id] ?? setup?.defaultMaterial ?? 'default');
    const baseColor = selected.has(hex.id) ? base.clone().lerp(SELECTED_HEX_COLOR, SELECTED_HEX_MIX) : base;
    const geometry = faceGrid(
      axis,
      sign,
      at,
      showField ? (a, b, g) => shapeFunctions20(a, b, g).reduce((sum, phi, i) => sum + phi * nodeValues[i], 0) : null,
      value => (value === null ? baseColor : rampColor(span > 0 ? (value - range.min) / span : 0))
    );
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.userData['pick'] = { kind: 'face', hex: hex.id, face: face.face } satisfies PickedFace;
    root.add(mesh);
    pickables.push(mesh);

    const key = `${hex.id}:${face.face}`;
    const picked = input.selectedFace?.hex === hex.id && input.selectedFace.face === face.face;
    const overlay = (color: number, opacity: number) => {
      const quad = faceGrid(axis, sign, at, null, () => new THREE.Color(color));
      const overlayMesh = new THREE.Mesh(
        quad,
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      );
      root.add(overlayMesh);
    };
    if (isFixed.has(key)) overlay(FIXED_COLOR, 0.6);
    if (isLoaded.has(key)) overlay(LOAD_COLOR, 0.6);
    if (picked) overlay(PICKED_FACE_COLOR, 0.55);
  }

  return { root, pickables, nodeMeshes: new Map() };
}

