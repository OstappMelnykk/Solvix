import * as THREE from 'three';
import { SolverMeshDto } from '../api/solver-api.service';
import { disposeObject3D } from './dispose-object3d';
import { markForWeightedOit } from '../rendering/weighted-oit';
import { LOCAL_COORDS, MeshView, PickedFace, faceAxis, faceSlots } from './mesh-editor-view';
import { FIXED_COLOR, OVERLAY_OPACITY, materialColor, pressureColor } from './solver-view';

// The Solver World's drawing of a mesh of finite elements that is not an even grid (a locally refined body): the solver's own flat list of elements,
// the faces on the surface drawn as small curved faces, so every element is as separately reachable as in the even division. Faces are named by
// (element key, local face), never by a cell of a grid.

export interface FemMeshViewInput {
  readonly mesh: SolverMeshDto;
  readonly defaultMaterial: string;
  readonly bodyColor: number;
  readonly opacity: number;
  readonly hiddenMaterials?: ReadonlySet<string>;
  readonly showFixed?: boolean;
  readonly showLoads?: boolean;
  readonly marksOpacity?: number;
  readonly edges?: boolean;
}

const RESOLUTION = 3;
const EDGE_SEGMENTS = 6;
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();
const EDGE_COLOR = 0x1a1d23;
// local face 0..5 as the solver numbers them
const LOCAL_FACE_NAMES = ['ZMinus', 'ZPlus', 'YMinus', 'YPlus', 'XMinus', 'XPlus'] as const;

interface FaceNodes {
  readonly slots: readonly number[];
  readonly uv: readonly (readonly [number, number])[];
}

const FACE_NODES: readonly FaceNodes[] = LOCAL_FACE_NAMES.map(name => {
  const axis = faceAxis(name);
  const others = [0, 1, 2].filter(a => a !== axis);
  const slots = faceSlots(name);
  return { slots, uv: slots.map(slot => [LOCAL_COORDS[slot][others[0]], LOCAL_COORDS[slot][others[1]]] as const) };
});

// the serendipity shape function of the node at (ui, vi) of a face
function shape(ui: number, vi: number, u: number, v: number): number {
  if (ui !== 0 && vi !== 0) return 0.25 * (1 + u * ui) * (1 + v * vi) * (u * ui + v * vi - 1);
  if (ui === 0) return 0.5 * (1 - u * u) * (1 + v * vi);
  return 0.5 * (1 + u * ui) * (1 - v * v);
}

export interface SurfaceFace {
  readonly element: number;
  readonly face: number;
}

export function femFaceName(face: number) {
  return LOCAL_FACE_NAMES[face];
}

// the point of an element's face at (u, v) in [-1, 1]^2
function pointOn(mesh: SolverMeshDto, element: number, face: number, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const { slots, uv } = FACE_NODES[face];
  out.set(0, 0, 0);
  for (let i = 0; i < slots.length; i++) {
    const w = shape(uv[i][0], uv[i][1], u, v);
    const node = mesh.connectivity[element * 20 + slots[i]] * 3;
    out.x += w * mesh.positions[node];
    out.y += w * mesh.positions[node + 1];
    out.z += w * mesh.positions[node + 2];
  }
  return out;
}

function pairs(list: readonly number[]): SurfaceFace[] {
  const out: SurfaceFace[] = [];
  for (let i = 0; i + 1 < list.length; i += 2) out.push({ element: list[i], face: list[i + 1] });
  return out;
}

const faceId = (f: SurfaceFace) => f.element * 6 + f.face;

export function buildFemMeshView(input: FemMeshViewInput): MeshView {
  const { mesh } = input;
  const root = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const hidden = input.hiddenMaterials ?? new Set<string>();
  const materialOf = (element: number) => mesh.materials[element] || input.defaultMaterial;
  const visible = pairs(mesh.surfaceFaces).filter(f => !hidden.has(materialOf(f.element)));
  const fixed = new Set(pairs(mesh.fixedFaces).map(faceId));
  const loaded = new Map<number, number>();
  pairs(mesh.loadedFaces).forEach((f, i) => loaded.set(faceId(f), mesh.pressures[i] ?? 0));
  const allPressures = [...loaded.values()];

  const stride = RESOLUTION + 1;
  const trianglesPerFace = RESOLUTION * RESOLUTION * 2;
  const point = new THREE.Vector3();

  const faceGeometry = (faces: readonly SurfaceFace[], colorOf: (f: SurfaceFace) => THREE.Color, shade: boolean): THREE.BufferGeometry => {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (const f of faces) {
      const base = positions.length / 3;
      const color = colorOf(f);
      for (let iv = 0; iv <= RESOLUTION; iv++)
        for (let iu = 0; iu <= RESOLUTION; iu++) {
          pointOn(mesh, f.element, f.face, -1 + (2 * iu) / RESOLUTION, -1 + (2 * iv) / RESOLUTION, point);
          positions.push(point.x, point.y, point.z);
          colors.push(color.r, color.g, color.b);
        }
      for (let iv = 0; iv < RESOLUTION; iv++)
        for (let iu = 0; iu < RESOLUTION; iu++) {
          const a = base + iv * stride + iu;
          indices.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
        }
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    buffer.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    buffer.setIndex(indices);
    if (shade) {
      // a fixed light baked into the colours: a face turned away from it is darker, which is what lets the eye read the shape
      buffer.computeVertexNormals();
      const normal = buffer.getAttribute('normal');
      const color = buffer.getAttribute('color');
      for (let i = 0; i < normal.count; i++) {
        const light = 0.58 + 0.42 * Math.abs(normal.getX(i) * LIGHT.x + normal.getY(i) * LIGHT.y + normal.getZ(i) * LIGHT.z);
        color.setXYZ(i, color.getX(i) * light, color.getY(i) * light, color.getZ(i) * light);
      }
    }
    return buffer;
  };

  const opacity = Math.min(1, Math.max(0.05, input.opacity));
  const solid = opacity >= 1;
  const body = new THREE.Mesh(
    faceGeometry(visible, f => (materialOf(f.element) === input.defaultMaterial ? new THREE.Color(input.bodyColor) : materialColor(materialOf(f.element))), true),
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !solid, opacity, depthWrite: solid })
  );
  markForWeightedOit(body.material as THREE.Material);
  // a click lands on a triangle; its face is the triangle's number divided by the triangles of one face
  const resolvePick = (triangle: number): PickedFace | null => {
    const f = visible[Math.floor(triangle / trianglesPerFace)];
    if (!f) return null;
    return {
      kind: 'face',
      hex: mesh.hexIds[f.element],
      face: LOCAL_FACE_NAMES[f.face],
      elementKey: mesh.keys[f.element],
      localFace: f.face
    };
  };
  body.userData['resolvePick'] = resolvePick;
  body.userData['pick'] = resolvePick(0);
  root.add(body);
  pickables.push(body);

  // clamped and pressed faces: a translucent coat each
  const marksOpacity = input.marksOpacity ?? OVERLAY_OPACITY;
  const coat = (faces: SurfaceFace[], colorOf: (f: SurfaceFace) => THREE.Color) => {
    if (faces.length === 0 || marksOpacity === 0) return;
    root.add(
      new THREE.Mesh(
        faceGeometry(faces, colorOf, false),
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: marksOpacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      )
    );
  };
  if (input.showFixed !== false) coat(visible.filter(f => fixed.has(faceId(f))), () => new THREE.Color(FIXED_COLOR));
  if (input.showLoads !== false) coat(visible.filter(f => loaded.has(faceId(f))), f => new THREE.Color(pressureColor(allPressures, loaded.get(faceId(f)) ?? 0)));

  // the edges of every face
  const lines: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const sides: readonly (readonly [number, number, number, number])[] = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]];
  for (const f of visible) {
    for (const [u0, v0, u1, v1] of sides) {
      pointOn(mesh, f.element, f.face, u0, v0, a);
      for (let s = 1; s <= EDGE_SEGMENTS; s++) {
        const t = s / EDGE_SEGMENTS;
        pointOn(mesh, f.element, f.face, u0 + (u1 - u0) * t, v0 + (v1 - v0) * t, b);
        lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
        a.copy(b);
      }
    }
  }
  if (lines.length > 0) {
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const edges = new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
    edges.userData['edges'] = true;
    edges.visible = input.edges !== false;
    root.add(edges);
  }

  let highlight: THREE.Object3D | null = null;
  const setHighlight = (group: THREE.Object3D | null) => {
    if (highlight) {
      root.remove(highlight);
      disposeObject3D(highlight);
    }
    highlight = group;
    if (group) root.add(group);
  };

  root.traverse(o => (o.frustumCulled = false));
  return { root, pickables, nodeMeshes: new Map(), setHighlight };
}

