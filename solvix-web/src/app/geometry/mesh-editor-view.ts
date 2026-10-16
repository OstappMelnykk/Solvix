import * as THREE from 'three';
import { createDepthFade } from '../rendering/depth-fade';
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
  // Solver World, locally refined body: the element's key and its local face (0..5) - what names a face of a mesh whatever made it.
  readonly elementKey?: string;
  readonly localFace?: number;
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
  // The Solver World's result views: move every vertex to the undeformed place plus `scale` times its displacement
  // (in place, no rebuild), and re-colour the field for a new top of the colour range.
  readonly setDeformation?: (scale: number) => void;
  readonly setColorRange?: (max: number) => void;
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
  // Nodes stuck to the imported surface: drawn in a colour of their own, a little larger.
  readonly attachedNodeIds?: ReadonlySet<number>;
  // Draw every node over the cubes and let a click on one win over the faces in front of it: the nodes inside the body
  // can be reached. Without it only the nodes of the picked cubes are.
  readonly xrayNodes?: boolean;
  // How opaque the faces are (0..1): the opacity of a linked face; the other states scale with it. Default 0.22.
  readonly faceOpacity?: number;
  // How large the dots of the cubes' corners and of their midpoints are, each as a share of the usual size (default 1). The click targets around them never get smaller than the usual ones.
  readonly nodeScale?: { readonly corner: number; readonly mid: number };
  // Draw the faces (default on); off when another view draws them and only the lines and nodes are wanted.
  readonly faces?: boolean;
  // Make the nodes clickable (default on); off for a view that is only looked at.
  readonly pickable?: boolean;
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

// One tone for every face of the body, so no face looks like another kind: only a candidate for linking (orange) and a picked face differ.
const BODY_FACE_COLOR = 0x4a8fe3;
const CANDIDATE_FACE_COLOR = 0xe08a2e;
// how opaque a face that is not picked is (a candidate for linking shows through the body a little more than the user's setting)
const CANDIDATE_MIN_OPACITY = 0.4;
// the opacity of the faces when the user has not set it
const DEFAULT_FACE_OPACITY = 0.22;
// how visible the farthest inner lines and nodes of a see-through body are (the nearest are fully visible)
const FAR_ALPHA = 0.15;
// the opacity from which the hidden (inner) lines and nodes begin to fade away: at this opacity and below they are fully there, at 100% they are gone, in between they
// fade evenly - so there is no jump between 99 % and 100 %
const GHOST_FULL_AT = 0.7;
const BASE_HEX_COLOR = 0x39c5f2;
const ADAPTING_HEX_COLOR = 0xc77dff;
const PREVIEW_FACE_COLOR = 0x6ee06e;
const PICKED_FACE_COLOR = 0xffe14d;
const SELECTED_NODE_COLOR = 0xff3b3b;
const ATTACHED_NODE_COLOR = 0xff4fd8;
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

// The state as it would be with a node dragged to `position` (a preview while the pointer is still down): a
// dragged corner may carry its edges' midpoints by half, like the server does. Everything else is derived from the
// node positions by the 20-node isoparametric map, so the rebuilt view follows the drag.
export function withNodeMoved(state: MeshStateDto, nodeId: number, position: THREE.Vector3Like, carryEdgeMidpoints: boolean): MeshStateDto {
  const start = state.nodes.find(n => n.id === nodeId);
  if (!start) return state;
  const delta = { x: position.x - start.x, y: position.y - start.y, z: position.z - start.z };
  const carried = new Set<number>();
  if (carryEdgeMidpoints) {
    for (const hex of state.hexes) {
      EDGE_CORNERS.forEach(([a, b], k) => {
        if (hex.nodeIds[a] === nodeId || hex.nodeIds[b] === nodeId) carried.add(hex.nodeIds[8 + k]);
      });
    }
  }
  return {
    ...state,
    nodes: state.nodes.map(n =>
      n.id === nodeId ? { ...n, x: position.x, y: position.y, z: position.z }
        : carried.has(n.id) ? { ...n, x: n.x + delta.x / 2, y: n.y + delta.y / 2, z: n.z + delta.z / 2 }
        : n
    )
  };
}

// Of the things a ray passes through, nearest first: a node that can be reached through other cubes wins over whatever
// is in front of it; otherwise the nearest.
export function preferredHit<T extends { object: { userData: Record<string, unknown> } }>(hits: readonly T[]): T | undefined {
  return hits.find(h => h.object.userData['priority'] === true) ?? hits[0];
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

  // A solid body (100 %) hides everything inside it; a see-through one shows the inner lines and nodes, the nearer ones
  // stronger and the farther ones dimmer.
  const faceOpacity = Math.min(1, Math.max(0, options.faceOpacity ?? DEFAULT_FACE_OPACITY));
  const seeThrough = faceOpacity < 1;
  // how much of the inner lines and nodes (those hidden by the body) is seen: 1 at GHOST_FULL_AT and below, 0 for a solid body
  const ghost = seeThrough ? Math.min(1, Math.max(0, (1 - faceOpacity) / (1 - GHOST_FULL_AT))) : 0;
  const bounds = new THREE.Box3();
  for (const node of state.nodes) bounds.expandByPoint(nodePosition(node, mode));
  const sphere = bounds.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : bounds.getBoundingSphere(new THREE.Sphere());
  const fade = createDepthFade(sphere.center, Math.max(sphere.radius, 1e-3), seeThrough ? FAR_ALPHA : 1);
  const lineMaterial = (color: number, opacity = 1, hidden = false): THREE.LineBasicMaterial => {
    const material = new THREE.LineBasicMaterial({ color, transparent: seeThrough || opacity < 1 || hidden, opacity: hidden ? opacity * ghost : opacity, depthTest: !hidden });
    fade.patch(material);
    return material;
  };
  // A line is drawn twice: where nothing of the body is in front of it (depth-tested against the faces, full strength), and again over everything, weaker the
  // more opaque the body is (that is what shows through the body).
  const addLines = (geometry: THREE.BufferGeometry, color: number, opacity = 1): void => {
    const lines = new THREE.LineSegments(geometry, lineMaterial(color, opacity));
    lines.renderOrder = 2;
    fade.track(lines);
    root.add(lines);
    if (ghost > 0.01) {
      const hidden = new THREE.LineSegments(geometry, lineMaterial(color, opacity, true));
      hidden.renderOrder = 2;
      fade.track(hidden);
      root.add(hidden);
    }
  };

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
    addLines(geometry, EDGE_COLOR);
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
      addLines(geometry, GRID_COLOR, 0.6);
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
      const dots = (hidden: boolean): THREE.Points => {
        const material = new THREE.PointsMaterial({ color: SUB_NODE_COLOR, size: SUB_NODE_SIZE, sizeAttenuation: true, transparent: seeThrough, opacity: hidden ? ghost : 1, depthTest: !hidden });
        fade.patch(material);
        const points = new THREE.Points(geometry, material);
        points.renderOrder = 3;
        fade.track(points);
        return points;
      };
      root.add(dots(false));
      if (ghost > 0.01) root.add(dots(true));
    }
  }

  // Faces, coloured by status.
  const hexById = new Map(state.hexes.map(hex => [hex.id, hex]));
  for (const face of state.faces) {
    const hex = hexById.get(face.hex);
    if (options.faces === false || !hex || !shouldDrawFace(face)) continue;
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
    const candidate = face.status === 'Candidate';
    const color = preview ? PREVIEW_FACE_COLOR : facePicked ? PICKED_FACE_COLOR : picked ? (pickIndex === 0 ? BASE_HEX_COLOR : ADAPTING_HEX_COLOR) : candidate ? CANDIDATE_FACE_COLOR : BODY_FACE_COLOR;
    // The outside of the body has the opacity the user set (100%: solid, it hides what is behind). A face between two linked cubes is inside the body:
    // it is not drawn unless it is picked or hovered (it can still be clicked), so no inner faces cloud the view.
    const inside = face.status === 'Linked';
    const opacity = preview || facePicked ? Math.max(0.6, faceOpacity) : picked ? Math.max(0.42, faceOpacity) : candidate ? Math.max(CANDIDATE_MIN_OPACITY, faceOpacity) : inside ? 0 : faceOpacity;
    // The faces are lit and shaded like a real body (smooth shading inside a face, a crease where two faces meet) but matt - no reflections of the light on
    // the surface - solid or not, so the look does not jump at 100 %; a translucent one blends over everything (it does not hide what is behind it).
    const solid = opacity >= 1;
    geometry.computeVertexNormals();
    const material =
      opacity <= 0
        ? new THREE.MeshBasicMaterial({ color, opacity: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide })
        : new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, transparent: !solid, opacity, depthWrite: solid, depthTest: solid });
    const mesh = new THREE.Mesh(geometry, material);
    // A translucent outside face also writes depth, invisibly, before the lines: what is in front of a line is then known, and the line is full strength
    // only where nothing is in front of it.
    if (!solid && !inside && opacity > 0) {
      const depthOnly = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }));
      depthOnly.renderOrder = 0;
      root.add(depthOnly);
    }
    mesh.renderOrder = 1;
    mesh.userData['pick'] = { kind: 'face', hex: face.hex, face: face.face } satisfies PickedFace;
    root.add(mesh);
    pickables.push(mesh);
  }

  // Nodes: corners and midpoints, one sphere per node (a shared node once).
  const cornerScale = Math.max(0.05, options.nodeScale?.corner ?? 1);
  const midScale = Math.max(0.05, options.nodeScale?.mid ?? 1);
  const cornerGeometry = new THREE.SphereGeometry(CORNER_RADIUS * cornerScale, 10, 8);
  const midGeometry = new THREE.SphereGeometry(MIDPOINT_RADIUS * midScale, 8, 6);
  const cornerHitGeometry = new THREE.SphereGeometry(Math.max(CORNER_HIT_RADIUS, CORNER_RADIUS * cornerScale * 1.4), 8, 6);
  const midHitGeometry = new THREE.SphereGeometry(Math.max(MIDPOINT_HIT_RADIUS, MIDPOINT_RADIUS * midScale * 1.4), 8, 6);
  const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  // The 20 nodes of the picked cubes (and of the cube of the picked face) can be reached through other cubes: they are
  // drawn over everything, and a click on one wins over the faces in front of it.
  const reachable = new Set<number>();
  const pickedHexes = new Set<number>(selection.hexes);
  if (selection.face) pickedHexes.add(selection.face.hex);
  for (const hex of state.hexes) if (pickedHexes.has(hex.id)) for (const id of hex.nodeIds) reachable.add(id);
  const cornerIds = new Set<number>();
  for (const hex of state.hexes) for (let slot = 0; slot < 8; slot++) cornerIds.add(hex.nodeIds[slot]);
  for (const node of options.showNodes === false ? [] : state.nodes) {
    const isCorner = cornerIds.has(node.id);
    const selected = selection.nodeId === node.id;
    const attached = options.attachedNodeIds?.has(node.id) === true;
    const nodeColor = selected ? SELECTED_NODE_COLOR : attached ? ATTACHED_NODE_COLOR : isCorner ? CORNER_COLOR : MIDPOINT_COLOR;
    const nodeMaterial = new THREE.MeshBasicMaterial({ color: nodeColor, transparent: seeThrough });
    fade.patch(nodeMaterial);
    const mesh = new THREE.Mesh(isCorner ? cornerGeometry : midGeometry, nodeMaterial);
    mesh.renderOrder = 3;
    fade.track(mesh);
    mesh.position.copy(nodePosition(node, mode));
    // the nodes of the picked cubes are drawn over everything; the others are seen where nothing of the body is in front of them, and (weaker, the more
    // opaque the body is) through it
    const drawnThrough = reachable.has(node.id);
    if (drawnThrough) {
      (mesh.material as THREE.MeshBasicMaterial).depthTest = false;
      mesh.renderOrder = 10;
    }
    // a click on an inner node wins over the faces in front of it while the body is still see-through enough for the node to be seen
    const through = drawnThrough || (options.xrayNodes === true && ghost > 0.2);
    if (selected) mesh.scale.setScalar(1.6);
    else if (attached) mesh.scale.setScalar(1.35);
    root.add(mesh);
    nodeMeshes.set(node.id, mesh);
    if (ghost > 0.01 && !drawnThrough) {
      const hiddenMaterial = new THREE.MeshBasicMaterial({ color: nodeColor, transparent: true, opacity: ghost, depthTest: false });
      fade.patch(hiddenMaterial);
      const hidden = new THREE.Mesh(isCorner ? cornerGeometry : midGeometry, hiddenMaterial);
      hidden.renderOrder = 4;
      fade.track(hidden);
      hidden.position.copy(mesh.position);
      hidden.scale.copy(mesh.scale);
      root.add(hidden);
    }

    if (options.pickable === false) continue;
    const hit = new THREE.Mesh(isCorner ? cornerHitGeometry : midHitGeometry, hitMaterial);
    hit.position.copy(mesh.position);
    hit.userData['pick'] = { kind: 'node', nodeId: node.id } satisfies PickedNode;
    if (through) hit.userData['priority'] = true;
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
    if (child instanceof THREE.Sprite) {
      child.material.map?.dispose();
      materials.add(child.material);
    } else if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Points) {
      geometries.add(child.geometry);
      (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => materials.add(m));
    }
  });
  geometries.forEach(g => g.dispose());
  materials.forEach(m => m.dispose());
}
