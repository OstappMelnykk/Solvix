import * as THREE from 'three';
import { ElementFaceRefDto, SolverMeshDto, SolverResultDto } from '../api/solver-api.service';
import { disposeObject3D } from './dispose-object3d';
import { markForWeightedOit } from '../rendering/weighted-oit';
import { FemHighlightInput, FemIndex } from './fem-targets';
import { LOCAL_COORDS, MeshView, PickedFace, faceAxis, faceSlots } from './mesh-editor-view';
import { buildDisplacementArrows } from './displacement-arrows';
import { Deformable, FIXED_COLOR, OVERLAY_OPACITY, SolverField, applyColorRange, applyDeformation, deformable, fieldRange, fieldValues, materialColor, pressureColor, rampColor } from './solver-view';

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
  // After a solve: the result on this mesh (its nodes are the mesh's), the field to colour by, how far to draw the deformation, the top of the colour range and whether to draw the vectors.
  readonly result?: SolverResultDto | null;
  readonly field?: SolverField;
  readonly deformationScale?: number;
  readonly colorMax?: number | null;
  readonly vectors?: boolean;
  // The Quality World's use: the colour an element is drawn in (null = as usual), elements left out, and whether the faces are filled or only the edges are drawn (in the elements' colours).
  readonly elementColor?: (element: number) => number | null;
  readonly skipElement?: (element: number) => boolean;
  readonly look?: 'solid' | 'edges';
}

const RESOLUTION = 3;
const EDGE_SEGMENTS = 6;
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();
const EDGE_COLOR = 0x1a1d23;
const PALE_EDGE_COLOR = 0xe6e8ec;
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

// the value of a per-node array at an element's face point (u, v)
function scalarOn(mesh: SolverMeshDto, element: number, face: number, u: number, v: number, values: readonly number[]): number {
  const { slots, uv } = FACE_NODES[face];
  let sum = 0;
  for (let i = 0; i < slots.length; i++) sum += shape(uv[i][0], uv[i][1], u, v) * values[mesh.connectivity[element * 20 + slots[i]]];
  return sum;
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
  const visible = pairs(mesh.surfaceFaces).filter(f => !hidden.has(materialOf(f.element)) && !input.skipElement?.(f.element));
  const fixed = new Set(pairs(mesh.fixedFaces).map(faceId));
  const loaded = new Map<number, number>();
  pairs(mesh.loadedFaces).forEach((f, i) => loaded.set(faceId(f), mesh.pressures[i] ?? 0));
  const allPressures = [...loaded.values()];

  // a result belongs to the mesh it was solved on: with another node count it means nothing here
  const result = input.result && input.result.positions.length === mesh.positions.length ? input.result : null;
  const field = input.field ?? 'none';
  const values = result ? fieldValues(result, field) : null;
  const top = values ? (input.colorMax && input.colorMax > 0 ? input.colorMax : fieldRange(values).max) : 0;
  const deformables: Deformable[] = [];

  const stride = RESOLUTION + 1;
  const trianglesPerFace = RESOLUTION * RESOLUTION * 2;
  const point = new THREE.Vector3();
  const moved = new THREE.Vector3();

  // `byField`: the surface is coloured by the field of the result; otherwise by colorOf
  const faceGeometry = (faces: readonly SurfaceFace[], colorOf: (f: SurfaceFace) => THREE.Color, shade: boolean, byField: boolean): THREE.BufferGeometry => {
    const positions: number[] = [];
    const displaced: number[] = [];
    const colors: number[] = [];
    const vertexValues: number[] = [];
    const indices: number[] = [];
    for (const f of faces) {
      const base = positions.length / 3;
      const color = colorOf(f);
      for (let iv = 0; iv <= RESOLUTION; iv++)
        for (let iu = 0; iu <= RESOLUTION; iu++) {
          const u = -1 + (2 * iu) / RESOLUTION;
          const v = -1 + (2 * iv) / RESOLUTION;
          pointOn(mesh, f.element, f.face, u, v, point);
          positions.push(point.x, point.y, point.z);
          if (result) {
            moved.set(scalarOn(mesh, f.element, f.face, u, v, result.ux), scalarOn(mesh, f.element, f.face, u, v, result.uy), scalarOn(mesh, f.element, f.face, u, v, result.uz));
            displaced.push(point.x + moved.x, point.y + moved.y, point.z + moved.z);
          }
          if (byField && values) {
            const value = scalarOn(mesh, f.element, f.face, u, v, values);
            vertexValues.push(value);
            const c = rampColor(top > 0 ? value / top : 0);
            colors.push(c.r, c.g, c.b);
          } else colors.push(color.r, color.g, color.b);
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
    if (result) deformables.push(deformable(buffer, positions, displaced, byField && values ? vertexValues : undefined, light));
    return buffer;
  };

  const opacity = Math.min(1, Math.max(0.05, input.opacity));
  const solid = opacity >= 1;
  const wire = input.look === 'edges';
  const body = new THREE.Mesh(
    faceGeometry(visible, f => {
      const own = input.elementColor?.(f.element);
      if (own !== null && own !== undefined) return new THREE.Color(own);
      return materialOf(f.element) === input.defaultMaterial ? new THREE.Color(input.bodyColor) : materialColor(materialOf(f.element));
    }, true, values !== null),
    // with only the edges drawn the faces are there to be pointed at, not to be seen
    wire ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false }) : new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: !solid, opacity, depthWrite: solid })
  );
  markForWeightedOit(body.material as THREE.Material);
  // a click lands on a triangle; its face is the triangle's number divided by the triangles of one face
  const resolvePick = (triangle: number): PickedFace | null => {
    const f = visible[Math.floor(triangle / trianglesPerFace)];
    if (!f) return null;
    return { kind: 'face', hex: mesh.hexIds[f.element], face: LOCAL_FACE_NAMES[f.face], elementKey: mesh.keys[f.element], localFace: f.face };
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
        faceGeometry(faces, colorOf, false, false),
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: marksOpacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      )
    );
  };
  if (input.showFixed !== false) coat(visible.filter(f => fixed.has(faceId(f))), () => new THREE.Color(FIXED_COLOR));
  if (input.showLoads !== false) coat(visible.filter(f => loaded.has(faceId(f))), f => new THREE.Color(pressureColor(allPressures, loaded.get(faceId(f)) ?? 0)));

  // the edges of every face
  const lines: number[] = [];
  const lineColors: number[] = [];
  const movedLines: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const sides: readonly (readonly [number, number, number, number])[] = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]];
  const displacedOn = (f: SurfaceFace, u: number, v: number, out: THREE.Vector3) =>
    pointOn(mesh, f.element, f.face, u, v, out).add(moved.set(scalarOn(mesh, f.element, f.face, u, v, result!.ux), scalarOn(mesh, f.element, f.face, u, v, result!.uy), scalarOn(mesh, f.element, f.face, u, v, result!.uz)));
  const darkEdge = new THREE.Color(EDGE_COLOR);
  const paleEdge = new THREE.Color(PALE_EDGE_COLOR);
  for (const f of visible) {
    const own = wire ? input.elementColor?.(f.element) : null;
    const edgeColor = wire ? (own !== null && own !== undefined ? new THREE.Color(own) : paleEdge) : darkEdge;
    for (const [u0, v0, u1, v1] of sides) {
      pointOn(mesh, f.element, f.face, u0, v0, a);
      const movedStart = result ? displacedOn(f, u0, v0, new THREE.Vector3()) : null;
      let movedLast = movedStart;
      for (let s = 1; s <= EDGE_SEGMENTS; s++) {
        const t = s / EDGE_SEGMENTS;
        const u = u0 + (u1 - u0) * t;
        const v = v0 + (v1 - v0) * t;
        pointOn(mesh, f.element, f.face, u, v, b);
        lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
        lineColors.push(edgeColor.r, edgeColor.g, edgeColor.b, edgeColor.r, edgeColor.g, edgeColor.b);
        a.copy(b);
        if (movedLast) {
          const next = displacedOn(f, u, v, new THREE.Vector3());
          movedLines.push(movedLast.x, movedLast.y, movedLast.z, next.x, next.y, next.z);
          movedLast = next;
        }
      }
    }
  }
  if (lines.length > 0) {
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    buffer.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
    if (result) deformables.push(deformable(buffer, lines, movedLines));
    const edges = new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ vertexColors: true }));
    edges.userData['edges'] = true;
    edges.visible = input.edges !== false;
    root.add(edges);
  }

  // the displacement vectors: arrows at the nodes, shown or hidden without a rebuild
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

  let highlight: THREE.Object3D | null = null;
  const setHighlight = (group: THREE.Object3D | null) => {
    if (highlight) {
      root.remove(highlight);
      disposeObject3D(highlight);
    }
    highlight = group;
    if (group) root.add(group);
  };

  // a moved vertex invalidates the bounds; nothing here is culled by them
  root.traverse(o => (o.frustumCulled = false));
  const view: MeshView = {
    root, pickables, nodeMeshes: new Map(), setHighlight,
    setDeformation: result ? scale => applyDeformation(deformables, scale) : undefined,
    setColorRange: result ? max => applyColorRange(deformables, max) : undefined
  };
  view.setDeformation?.(input.deformationScale ?? 0);
  return view;
}

// The 12 edges of an element as (corner, corner) of its 20 nodes; edge k has its midpoint at slot 8 + k.
const ELEMENT_EDGES: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const HIGHLIGHT_COLOR = 0xffe14d;

// What a click would act on, drawn over the view: the faces as a coat, the elements as their edges, the face under the pointer on its own.
export function buildFemHighlight(mesh: SolverMeshDto, index: FemIndex, target: FemHighlightInput, limit = 400): THREE.Group {
  const group = new THREE.Group();
  const quads: number[] = [];
  const quadIndices: number[] = [];
  const lines: number[] = [];
  const p = new THREE.Vector3();
  const stride = RESOLUTION + 1;
  let used = 0;

  const addFace = (ref: ElementFaceRefDto) => {
    const element = index.element.get(ref.key);
    if (element === undefined) return;
    const base = quads.length / 3;
    for (let iv = 0; iv <= RESOLUTION; iv++)
      for (let iu = 0; iu <= RESOLUTION; iu++) {
        pointOn(mesh, element, ref.face, -1 + (2 * iu) / RESOLUTION, -1 + (2 * iv) / RESOLUTION, p);
        quads.push(p.x, p.y, p.z);
      }
    for (let iv = 0; iv < RESOLUTION; iv++)
      for (let iu = 0; iu < RESOLUTION; iu++) {
        const first = base + iv * stride + iu;
        quadIndices.push(first, first + 1, first + stride, first + 1, first + stride + 1, first + stride);
      }
  };

  const node = (element: number, slot: number, out: THREE.Vector3) => {
    const at = mesh.connectivity[element * 20 + slot] * 3;
    return out.set(mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]);
  };
  const addElement = (key: string) => {
    const element = index.element.get(key);
    if (element === undefined) return;
    const [a, m, b] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    ELEMENT_EDGES.forEach(([c0, c1], k) => {
      node(element, c0, a);
      node(element, 8 + k, m);
      node(element, c1, b);
      let last = a.clone();
      for (let s = 1; s <= 4; s++) {
        const t = -1 + (2 * s) / 4;
        // the curve through the edge's three nodes
        const next = a.clone().multiplyScalar((t * (t - 1)) / 2).addScaledVector(m, 1 - t * t).addScaledVector(b, (t * (t + 1)) / 2);
        lines.push(last.x, last.y, last.z, next.x, next.y, next.z);
        last = next;
      }
    });
  };

  for (const f of target.faces) if (used++ < limit) addFace(f);
  for (const key of target.elements) if (used++ < limit) addElement(key);
  if (target.pointed) addFace(target.pointed);

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
  group.traverse(o => (o.frustumCulled = false));
  return group;
}
