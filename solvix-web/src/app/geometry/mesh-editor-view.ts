import * as THREE from 'three';
import { FaceStatus, HexFaceName, MeshFaceDto, MeshNodeDto, MeshStateDto } from '../api/mesh-editor-api.service';

// Pure drawing of the backend's mesh state - no geometry decisions here, and no
// points that are not in the mesh: nodes are drawn exactly where the server says,
// an edge is the two straight pieces corner -> midpoint -> corner through its 3
// nodes, and a face is filled between its 8 nodes. (The smooth parabola the shape
// functions define between them is not drawn - only the optional inner grid below
// samples the functions, and it is off by default.)

export type MeshViewMode = 'ideal' | 'real';

export interface PickedFace {
  readonly kind: 'face';
  readonly hex: number;
  readonly face: HexFaceName;
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
  readonly subdivisions: number;
}

const GRID_LINE_SAMPLES = 12;
const GRID_COLOR = 0x6f8fb8;
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

// The 8 slots of a face in order around its perimeter, so the face can be filled
// as one polygon through its own nodes.
const PERIMETER_UV: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]
];

// A face filled between its 8 nodes only (a fan of 6 triangles from the first
// corner) - no interpolated points.
function buildFaceGeometry(perimeter: THREE.Vector3[]): THREE.BufferGeometry {
  const positions: number[] = [];
  perimeter.forEach(p => positions.push(p.x, p.y, p.z));
  const indices: number[] = [];
  for (let i = 1; i < perimeter.length - 1; i++) {
    indices.push(0, i, i + 1);
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

  // Edges: corner -> midpoint -> corner, straight between the real nodes.
  const edgeVertices: number[] = [];
  for (const hex of state.hexes) {
    EDGE_CORNERS.forEach(([a, b], k) => {
      const start = positionOf(hex.nodeIds[a]);
      const mid = positionOf(hex.nodeIds[8 + k]);
      const end = positionOf(hex.nodeIds[b]);
      edgeVertices.push(start.x, start.y, start.z, mid.x, mid.y, mid.z, mid.x, mid.y, mid.z, end.x, end.y, end.z);
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
  const cells = Math.max(1, Math.floor(options.subdivisions));
  if (cells > 1) {
    const gridVertices: number[] = [];
    for (const hex of state.hexes) {
      const slotPositions = hex.nodeIds.map(id => positionOf(id));
      for (let axis = 0; axis < 3; axis++) {
        const [u, v] = [0, 1, 2].filter(d => d !== axis);
        for (let k1 = 0; k1 <= cells; k1++) {
          for (let k2 = 0; k2 <= cells; k2++) {
            if ((k1 === 0 || k1 === cells) && (k2 === 0 || k2 === cells)) continue;
            let previous: THREE.Vector3 | null = null;
            for (let s = 0; s <= GRID_LINE_SAMPLES; s++) {
              const local = [0, 0, 0];
              local[axis] = (s / GRID_LINE_SAMPLES) * 2 - 1;
              local[u] = (k1 / cells) * 2 - 1;
              local[v] = (k2 / cells) * 2 - 1;
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
      PERIMETER_UV.map(([u, v]) => {
        const slot = slots.find(s => LOCAL_COORDS[s][tangent[0]] === u && LOCAL_COORDS[s][tangent[1]] === v)!;
        return positionOf(hex.nodeIds[slot]);
      })
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
  for (const node of state.nodes) {
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
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      geometries.add(child.geometry);
      (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => materials.add(m));
    }
  });
  geometries.forEach(g => g.dispose());
  materials.forEach(m => m.dispose());
}
