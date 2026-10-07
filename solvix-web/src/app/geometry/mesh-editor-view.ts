import * as THREE from 'three';
import { FaceStatus, HexFaceName, MeshFaceDto, MeshNodeDto, MeshStateDto } from '../api/mesh-editor-api.service';

// Pure drawing of the backend's mesh state - no geometry decisions here: the
// nodes are placed exactly where the server says, and the curved edges/faces
// are just the same quadratic (serendipity) interpolation the server's
// elements use, sampled finely enough to look smooth.

export type MeshViewMode = 'ideal' | 'real';

export interface PickedFace {
  readonly kind: 'face';
  readonly hex: number;
  readonly face: HexFaceName;
  // Solver World only, where a cube is cut into small elements: the cell of the side's grid that was hit ...
  readonly p?: number;
  readonly q?: number;
  // ... the small element behind that small face (its index along each axis of the cube) ...
  readonly element?: readonly [number, number, number];
  // ... and whether the face lies inside the body (between small elements) rather than on its outside.
  readonly inner?: boolean;
}

export interface PickedNode {
  readonly kind: 'node';
  readonly nodeId: number;
}

export type MeshPick = PickedFace | PickedNode;

export interface MeshViewSelection {
  // Picked cubes in pick order: the first is the base (cyan), the second the one
  // that adapts to it (violet).
  readonly hexes: readonly number[];
  // The face a plain click picked (yellow).
  readonly face: { readonly hex: number; readonly face: HexFaceName } | null;
  // The face whose "add a cube" button is hovered - drawn as a preview.
  readonly hoverFace: { readonly hex: number; readonly face: HexFaceName } | null;
  readonly nodeId: number | null;
}

export interface MeshView {
  readonly root: THREE.Group;
  // What a click can hit: faces and the (larger, invisible) hit spheres around
  // the nodes; each carries its identity in userData.pick.
  readonly pickables: THREE.Object3D[];
  // Highlights what a click would act on: the Solver World draws it into the view without rebuilding the view.
  readonly setHighlight?: (group: THREE.Object3D | null) => void;
  // The visible sphere of each node, by node id - the canvas moves one while
  // its node is being dragged.
  readonly nodeMeshes: ReadonlyMap<number, THREE.Mesh>;
}

// Same node layout as Solvix.Mesh's Hex20Reference.
export const LOCAL_COORDS: readonly (readonly [number, number, number])[] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  [0, -1, -1], [1, 0, -1], [0, 1, -1], [-1, 0, -1],
  [0, -1, 1], [1, 0, 1], [0, 1, 1], [-1, 0, 1],
  [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]
];

// Edge k carries midpoint slot 8 + k.
const EDGE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]
];

export const FACE_NAMES: readonly HexFaceName[] = ['XMinus', 'XPlus', 'YMinus', 'YPlus', 'ZMinus', 'ZPlus'];

export function faceAxis(face: HexFaceName): number {
  return FACE_NAMES.indexOf(face) >> 1;
}

export function faceSign(face: HexFaceName): number {
  return FACE_NAMES.indexOf(face) % 2 === 0 ? -1 : 1;
}

// The 8 slots (4 corners + 4 midpoints) on a face.
export function faceSlots(face: HexFaceName): number[] {
  const axis = faceAxis(face);
  const sign = faceSign(face);
  return LOCAL_COORDS.map((c, slot) => (c[axis] === sign ? slot : -1)).filter(slot => slot >= 0);
}

// The 20 serendipity shape functions - the same formulas as the backend's
// Hex20Reference and the solver's N20 (docs/ISOPARAMETRIC.md): corner i is
// 1/8 (1+aᵢa)(1+bᵢb)(1+gᵢg)(aᵢa+bᵢb+gᵢg-2), a midside node has the (1-t²) factor
// along its own axis. Used here only to DRAW the inside of a cube.
export function shapeFunctions20(a: number, b: number, g: number): number[] {
  const phi = new Array<number>(20);
  for (let i = 0; i < 20; i++) {
    const [ai, bi, ci] = LOCAL_COORDS[i];
    if (i < 8) {
      phi[i] = 0.125 * (1 + ai * a) * (1 + bi * b) * (1 + ci * g) * (ai * a + bi * b + ci * g - 2);
    } else if (ai === 0) {
      phi[i] = 0.25 * (1 - a * a) * (1 + bi * b) * (1 + ci * g);
    } else if (bi === 0) {
      phi[i] = 0.25 * (1 + ai * a) * (1 - b * b) * (1 + ci * g);
    } else {
      phi[i] = 0.25 * (1 + ai * a) * (1 + bi * b) * (1 - g * g);
    }
  }
  return phi;
}

// x(a,b,g) = sum_i phi_i(a,b,g) * x[node in local slot i]: where a point of the
// cube with local coordinates (a,b,g) is, given the 20 node positions.
export function mapHex(slotPositions: readonly THREE.Vector3[], a: number, b: number, g: number): THREE.Vector3 {
  const phi = shapeFunctions20(a, b, g);
  const point = new THREE.Vector3();
  for (let i = 0; i < 20; i++) {
    point.addScaledVector(slotPositions[i], phi[i]);
  }
  return point;
}

export interface MeshViewOptions {
  // Each cube is cut into n x n x n cells by lines of constant local coordinate,
  // pushed through the shape functions (1 = off). It shows how the 20 nodes bend
  // every point inside the cube.
  readonly subdivisions: number | readonly [number, number, number];
  // Draw (and make pickable) the node dots; off for a big body that is only looked at. Default on.
  readonly showNodes?: boolean;
}

const GRID_LINE_SAMPLES = 12;
const GRID_COLOR = 0x6f8fb8;
const SUB_NODE_COLOR = 0xbfd9ff;
const SUB_NODE_SIZE = 0.035;
const EDGE_SEGMENTS = 10;
const FACE_GRID = 8;
const CORNER_RADIUS = 0.045;
const MIDPOINT_RADIUS = 0.032;
// Click targets are larger than the dots drawn, so a node is easy to hit.
const CORNER_HIT_RADIUS = 0.11;
const MIDPOINT_HIT_RADIUS = 0.08;

const FACE_COLORS: Record<FaceStatus, number> = {
  Free: 0x5b8fb9,
  Linked: 0x4fb477,
  Candidate: 0xe08a2e
};
const FACE_OPACITY: Record<FaceStatus, number> = { Free: 0.16, Linked: 0.22, Candidate: 0.4 };
const BASE_HEX_COLOR = 0x39c5f2;
const ADAPTING_HEX_COLOR = 0xc77dff;
const PREVIEW_FACE_COLOR = 0x6ee06e;
const PICKED_FACE_COLOR = 0xffe14d;
const SELECTED_NODE_COLOR = 0xff3b3b;
const EDGE_COLOR = 0xe6e8ec;
const CORNER_COLOR = 0xffffff;
const MIDPOINT_COLOR = 0xf2d34a;

export function nodePosition(node: MeshNodeDto, mode: MeshViewMode): THREE.Vector3 {
  return mode === 'ideal'
    ? new THREE.Vector3(node.idealX / 2, node.idealY / 2, node.idealZ / 2)
    : new THREE.Vector3(node.x, node.y, node.z);
}

// Quadratic Lagrange through (start, mid, end) at t = -1, 0, 1 - exactly how
// an edge of the 20-node element bends.
function edgePoint(start: THREE.Vector3, mid: THREE.Vector3, end: THREE.Vector3, t: number): THREE.Vector3 {
  return start
    .clone()
    .multiplyScalar((t * (t - 1)) / 2)
    .addScaledVector(mid, 1 - t * t)
    .addScaledVector(end, (t * (t + 1)) / 2);
}

// 8-node serendipity shape functions on a face, (u, v) in [-1, 1]^2.
function faceShape(ui: number, vi: number, u: number, v: number): number {
  if (ui !== 0 && vi !== 0) return 0.25 * (1 + u * ui) * (1 + v * vi) * (u * ui + v * vi - 1);
  if (ui === 0) return 0.5 * (1 - u * u) * (1 + v * vi);
  return 0.5 * (1 + u * ui) * (1 - v * v);
}

function buildFaceGeometry(slotPositions: THREE.Vector3[], slotUv: [number, number][]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let iv = 0; iv <= FACE_GRID; iv++) {
    for (let iu = 0; iu <= FACE_GRID; iu++) {
      const u = (iu / FACE_GRID) * 2 - 1;
      const v = (iv / FACE_GRID) * 2 - 1;
      const point = new THREE.Vector3();
      slotPositions.forEach((p, i) => point.addScaledVector(p, faceShape(slotUv[i][0], slotUv[i][1], u, v)));
      positions.push(point.x, point.y, point.z);
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
  geometry.setIndex(indices);
  return geometry;
}

// A shared (linked) face is one surface seen from two hexes, and a candidate
// pair whose faces coincide is two surfaces in one place - drawing both would
// z-fight, so only the lower-id side is drawn (clicking it still identifies a
// real face of a real hex).
function shouldDrawFace(face: MeshFaceDto): boolean {
  if (face.otherHex === null) return true;
  if (face.status === 'Linked' || face.coincident === true) return face.hex < face.otherHex;
  return true;
}

export function buildMeshView(
  state: MeshStateDto,
  mode: MeshViewMode,
  selection: MeshViewSelection,
  options: MeshViewOptions = { subdivisions: 1 }
): MeshView {
  const root = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const nodeMeshes = new Map<number, THREE.Mesh>();
  const nodes = new Map(state.nodes.map(node => [node.id, node]));
  const positionOf = (id: number) => nodePosition(nodes.get(id)!, mode);

  // Curved edges: one polyline set for the whole mesh.
  const edgeVertices: number[] = [];
  for (const hex of state.hexes) {
    EDGE_CORNERS.forEach(([a, b], k) => {
      const start = positionOf(hex.nodeIds[a]);
      const mid = positionOf(hex.nodeIds[8 + k]);
      const end = positionOf(hex.nodeIds[b]);
      let previous = start;
      for (let i = 1; i <= EDGE_SEGMENTS; i++) {
        const next = edgePoint(start, mid, end, (i / EDGE_SEGMENTS) * 2 - 1);
        edgeVertices.push(previous.x, previous.y, previous.z, next.x, next.y, next.z);
        previous = next;
      }
    });
  }
  if (edgeVertices.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(edgeVertices, 3));
    root.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: EDGE_COLOR })));
  }

  // Inside of each cube: lines of constant (alpha, beta, gamma) through the shape
  // functions. The 12 edges are drawn above already, so a line is skipped when
  // both of its fixed coordinates sit on the cube's boundary.
  const counts = (Array.isArray(options.subdivisions) ? options.subdivisions : [options.subdivisions, options.subdivisions, options.subdivisions]).map(n => Math.max(1, Math.floor(n)));
  if (counts.some(n => n > 1)) {
    const gridVertices: number[] = [];
    for (const hex of state.hexes) {
      const slotPositions = hex.nodeIds.map(id => positionOf(id));
      for (let axis = 0; axis < 3; axis++) {
        const [u, v] = [0, 1, 2].filter(d => d !== axis);
        for (let k1 = 0; k1 <= counts[u]; k1++) {
          for (let k2 = 0; k2 <= counts[v]; k2++) {
            if ((k1 === 0 || k1 === counts[u]) && (k2 === 0 || k2 === counts[v])) continue;
            let previous: THREE.Vector3 | null = null;
            for (let s = 0; s <= GRID_LINE_SAMPLES; s++) {
              const local = [0, 0, 0];
              local[axis] = (s / GRID_LINE_SAMPLES) * 2 - 1;
              local[u] = (k1 / counts[u]) * 2 - 1;
              local[v] = (k2 / counts[v]) * 2 - 1;
              const point = mapHex(slotPositions, local[0], local[1], local[2]);
              if (previous) {
                gridVertices.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
              }
              previous = point;
            }
          }
        }
      }
    }
    if (gridVertices.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(gridVertices, 3));
      root.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.6 })));
    }

    // The nodes the divided cube would really have, as the solver builds them: a grid of (2n+1)^3 points of which
    // only those with at most one odd index exist (corners and edge midpoints of every small cell), each at the
    // shape-function image of its place. The cube's own 20 nodes are drawn as spheres, so they are left out here.
    const subNodes: number[] = [];
    for (const hex of state.hexes) {
      const slotPositions = hex.nodeIds.map(id => positionOf(id));
      const isParentNode = (ix: number, iy: number, iz: number) => {
        const index = [ix, iy, iz];
        return index.every((i, d) => i === 0 || i === counts[d] || i === 2 * counts[d]) && index.filter((i, d) => i === counts[d]).length <= 1;
      };
      for (let iz = 0; iz <= 2 * counts[2]; iz++) {
        for (let iy = 0; iy <= 2 * counts[1]; iy++) {
          for (let ix = 0; ix <= 2 * counts[0]; ix++) {
            if ((ix % 2) + (iy % 2) + (iz % 2) > 1) continue;
            if (isParentNode(ix, iy, iz)) continue;
            const point = mapHex(slotPositions, ix / counts[0] - 1, iy / counts[1] - 1, iz / counts[2] - 1);
            subNodes.push(point.x, point.y, point.z);
          }
        }
      }
    }
    if (subNodes.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(subNodes, 3));
      root.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: SUB_NODE_COLOR, size: SUB_NODE_SIZE, sizeAttenuation: true })));
    }
  }

  // Faces, coloured by status.
  const hexById = new Map(state.hexes.map(hex => [hex.id, hex]));
  for (const face of state.faces) {
    const hex = hexById.get(face.hex);
    if (!hex || !shouldDrawFace(face)) continue;
    const axis = faceAxis(face.face);
    const tangent = [0, 1, 2].filter(d => d !== axis);
    const slots = faceSlots(face.face);
    const geometry = buildFaceGeometry(
      slots.map(slot => positionOf(hex.nodeIds[slot])),
      slots.map(slot => [LOCAL_COORDS[slot][tangent[0]], LOCAL_COORDS[slot][tangent[1]]] as [number, number])
    );
    // A shared face is drawn once (from the lower-id hex) but belongs to both,
    // so it is tinted when either side's cube is picked (the base wins).
    const pickIndex = [selection.hexes.indexOf(face.hex), face.otherHex === null ? -1 : selection.hexes.indexOf(face.otherHex)]
      .filter(i => i >= 0)
      .sort((a, b) => a - b)[0];
    const picked = pickIndex !== undefined;
    const preview = selection.hoverFace?.hex === face.hex && selection.hoverFace.face === face.face;
    const facePicked = selection.face?.hex === face.hex && selection.face.face === face.face;
    const color = preview ? PREVIEW_FACE_COLOR : facePicked ? PICKED_FACE_COLOR : picked ? (pickIndex === 0 ? BASE_HEX_COLOR : ADAPTING_HEX_COLOR) : FACE_COLORS[face.status];
    const material = new THREE.MeshBasicMaterial({
      color,
      opacity: preview || facePicked ? 0.6 : picked ? 0.42 : FACE_OPACITY[face.status],
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData['pick'] = { kind: 'face', hex: face.hex, face: face.face } satisfies PickedFace;
    root.add(mesh);
    pickables.push(mesh);
  }

  // Nodes: corners and midpoints, one sphere per node (a shared node once).
  const cornerGeometry = new THREE.SphereGeometry(CORNER_RADIUS, 10, 8);
  const midGeometry = new THREE.SphereGeometry(MIDPOINT_RADIUS, 8, 6);
  const cornerHitGeometry = new THREE.SphereGeometry(CORNER_HIT_RADIUS, 8, 6);
  const midHitGeometry = new THREE.SphereGeometry(MIDPOINT_HIT_RADIUS, 8, 6);
  const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const cornerIds = new Set<number>();
  for (const hex of state.hexes) for (let slot = 0; slot < 8; slot++) cornerIds.add(hex.nodeIds[slot]);
  for (const node of options.showNodes === false ? [] : state.nodes) {
    const isCorner = cornerIds.has(node.id);
    const selected = selection.nodeId === node.id;
    const mesh = new THREE.Mesh(
      isCorner ? cornerGeometry : midGeometry,
      new THREE.MeshBasicMaterial({ color: selected ? SELECTED_NODE_COLOR : isCorner ? CORNER_COLOR : MIDPOINT_COLOR })
    );
    mesh.position.copy(nodePosition(node, mode));
    if (selected) mesh.scale.setScalar(1.6);
    root.add(mesh);
    nodeMeshes.set(node.id, mesh);

    const hit = new THREE.Mesh(isCorner ? cornerHitGeometry : midHitGeometry, hitMaterial);
    hit.position.copy(mesh.position);
    hit.userData['pick'] = { kind: 'node', nodeId: node.id } satisfies PickedNode;
    root.add(hit);
    pickables.push(hit);
  }

  return { root, pickables, nodeMeshes };
}

// Frees everything buildMeshView made. Node spheres share two geometries, so
// each is disposed once (three.js tolerates repeats, but this keeps it explicit).
export function disposeMeshView(view: MeshView): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  view.root.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Points) {
      geometries.add(child.geometry);
      (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => materials.add(m));
    }
  });
  geometries.forEach(g => g.dispose());
  materials.forEach(m => m.dispose());
}
