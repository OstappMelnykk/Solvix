import * as THREE from 'three';
import { HexFaceName, MeshHexDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { SolverQualityDto, SolverSetupDto } from '../api/solver-api.service';
import { createDepthFade } from '../rendering/depth-fade';
import { MeshView, PickedFace } from './mesh-editor-view';
import { QualityMetric, measuredGrade, resultOf } from './quality-grading';
import {
  DrawnFace, FIXED_COLOR, LOAD_COLOR, OVERLAY_OPACITY, RESULT_COLORS, SectionCut, SolverGeometry,
  appendSurface, disposeObject, elementSectionLoops, faceName, facePoint, faceResolution, planeSlack, pressureColor, pressureLabel,
  sectionPlane, triangulateLoop
} from './solver-view';

// The 3D view of the Quality World, built on its own (not from the Solver World's view): the body cut into the solver's small
// elements, drawn the way the Real World draws a body - lit matt faces of one tone, pale edges, the nodes as dots - and every
// small element coloured by its grade.
//
// What makes it hold together:
//  - the edges are drawn BY THE FACES (in their own shader, from the position inside each small face), not as separate lines laid over
//    them, so an edge can neither sink into a face nor fight it for the pixel, and it is cut by a section together with the face;
//  - a section is a clipping plane of the GPU, applied to every material of the view (faces, edges, nodes) alike - nothing is cut by hand;
//  - the cut itself (the cap of every small element the plane runs through) is the one thing built by hand, and it is lit like the faces.
// The canvas's renderer must have localClippingEnabled for the section to cut.

export interface QualityViewInput {
  readonly state: MeshStateDto;
  readonly setup: SolverSetupDto | null;
  readonly quality: SolverQualityDto | null;
  // what the colours show: the overall grade or one measure
  readonly metric: QualityMetric;
  // 0..1, the one opacity of the body
  readonly opacity: number;
  // draw just the elements the metric does not grade excellent
  readonly onlyBad: boolean;
  readonly section?: SectionCut;
  readonly showFixed: boolean;
  readonly showLoads: boolean;
}

// The look is the Real World's.
const BODY_COLOR = 0x4a8fe3;
const EDGE_COLOR = [0.9, 0.91, 0.93];
const CORNER_COLOR = 0xffffff;
const MIDPOINT_COLOR = 0xf2d34a;
const SUB_NODE_COLOR = 0xbfd9ff;
const CORNER_RADIUS = 0.045;
const MIDPOINT_RADIUS = 0.032;
const SUB_NODE_SIZE = 0.035;
const CAP_OUTLINE_COLOR = 0xe6e8ec;
// the opacity from which the dots hidden by the body begin to fade away (as in the Real World)
const GHOST_FULL_AT = 0.7;
const DOT_SPHERE_SEGMENTS = [10, 8] as const;
// how visible the farthest edges and dots of a see-through body are (the nearest are fully visible), as in the Real World
const FAR_ALPHA = 0.1;

// The depth range of the body as the camera sees it, shared by the shaders that fade with depth: refreshed from the camera before the object is drawn.
interface FadeUniforms {
  readonly uFadeNear: { value: number };
  readonly uFadeFar: { value: number };
  readonly uFadeMin: { value: number };
}

function trackFade(object: THREE.Object3D, uniforms: FadeUniforms, centre: THREE.Vector3, radius: number): void {
  const inView = new THREE.Vector3();
  object.onBeforeRender = (_renderer, _scene, camera) => {
    inView.copy(centre).applyMatrix4(camera.matrixWorldInverse);
    uniforms.uFadeNear.value = -inView.z - radius;
    uniforms.uFadeFar.value = -inView.z + radius;
  };
}

// A matt lit material whose faces draw their own edges: where the position inside a small face (u, v in [-1, 1]) is within a
// pixel or so of its border, the colour goes to the edge colour (and the face to opaque, so the edge of a see-through body still reads).
function litFaceMaterial(options: { transparent: boolean; opacity: number; solid: boolean; clip: THREE.Plane[] }, edgeStrength: number, fade: FadeUniforms): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: options.transparent,
    opacity: options.opacity,
    // see-through, every face blends with all the others (no depth test), so the tone does not depend on the order they are drawn in
    depthWrite: options.solid,
    depthTest: options.solid,
    clippingPlanes: options.clip
  });
  material.customProgramCacheKey = () => 'quality-face-edges';
  material.onBeforeCompile = shader => {
    shader.uniforms['uFadeNear'] = fade.uFadeNear;
    shader.uniforms['uFadeFar'] = fade.uFadeFar;
    shader.uniforms['uFadeMin'] = fade.uFadeMin;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 faceUv;\nvarying vec2 vFaceUv;\nvarying float vFadeDepth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFaceUv = faceUv;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFadeDepth = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFaceUv;\nvarying float vFadeDepth;\nuniform float uFadeNear;\nuniform float uFadeFar;\nuniform float uFadeMin;')
      .replace(
        '#include <opaque_fragment>',
        `vec2 edgeD = 1.0 - abs(vFaceUv);
        vec2 edgeW = max(fwidth(vFaceUv), vec2(1e-6));
        float edgeLine = 1.0 - smoothstep(0.4, 1.3, min(edgeD.x / edgeW.x, edgeD.y / edgeW.y));
        edgeLine *= mix(1.0, uFadeMin, clamp((vFadeDepth - uFadeNear) / max(uFadeFar - uFadeNear, 0.0001), 0.0, 1.0));
        outgoingLight = mix(outgoingLight, vec3(${EDGE_COLOR.join(', ')}), edgeLine);
        diffuseColor.a = mix(diffuseColor.a, 1.0, edgeLine * ${edgeStrength.toFixed(2)});
        #include <opaque_fragment>`
      );
  };
  return material;
}

// The faces drawn: the ones between a visible small element and what is not visible (or the outside), and - with the body see-through - all
// the faces of the bad elements, so one inside the body can be seen.
function drawnFaces(
  state: MeshStateDto,
  geometry: SolverGeometry,
  visible: (hex: number, ex: number, ey: number, ez: number) => boolean,
  isBad: (hex: number, ex: number, ey: number, ez: number) => boolean,
  seeThrough: boolean
): DrawnFace[] {
  const counts = geometry.counts;
  const hexById = new Map(state.hexes.map(h => [h.id, h]));
  const links = new Map<string, { hex: number; face: HexFaceName }>();
  for (const f of state.faces) if (f.status === 'Linked' && f.otherHex !== null && f.otherFace !== null) links.set(`${f.hex}:${f.face}`, { hex: f.otherHex, face: f.otherFace });

  const out: DrawnFace[] = [];
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
            let low: { hex: MeshHexDto; element: [number, number, number] } | null = t > 0 ? { hex, element: index(t - 1) } : null;
            let high: { hex: MeshHexDto; element: [number, number, number] } | null = t < counts[axis] ? { hex, element: index(t) } : null;
            let linked = false;
            if (!low || !high) {
              // on a side of the cube: across it is the next cube, or nothing
              const link = links.get(`${hex.id}:${faceName(axis, t > 0)}`);
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
            const lowBad = lowVisible && isBad(low!.hex.id, ...low!.element), highBad = highVisible && isBad(high!.hex.id, ...high!.element);
            const keep = lowVisible !== highVisible || (lowVisible && highVisible && seeThrough && (lowBad || highBad));
            if (!keep) continue;
            const ownerIsHigh = highVisible && !(lowVisible && lowBad && !highBad);   // with both visible: the high side, but the bad one wins
            const owner = ownerIsHigh ? high! : low!;
            out.push({
              drawer: hex,
              axis, t, p, q,
              owner: owner.hex,
              element: owner.element,
              face: faceName(axis, !ownerIsHigh),                         // the high element meets the face on its minus side
              outer: !linked && (t === 0 || t === counts[axis])
            });
          }
        }
      }
    }
  }
  return out;
}

export function buildQualityView(input: QualityViewInput): MeshView {
  const { state, setup, quality } = input;
  const root = new THREE.Group();
  const divisions = (setup?.divisions ?? [1, 1, 1]) as [number, number, number];
  const geometry = new SolverGeometry(state, divisions, null, 0, 'none');
  const counts = geometry.counts;
  const resolution = faceResolution(counts);
  const trianglesPerFace = 2 * resolution * resolution;
  const opacity = Math.min(1, Math.max(0.05, input.opacity));
  const solid = opacity >= 1;
  const seeThrough = !solid;
  // how much of what the body hides is seen: everything at GHOST_FULL_AT and below, nothing for a solid body
  const ghost = seeThrough ? Math.min(1, Math.max(0, (1 - opacity) / (1 - GHOST_FULL_AT))) : 0;

  // ---- grades ----
  const grades = quality ? new Map(quality.flagged.map(e => [`${e.hex}:${e.ex}:${e.ey}:${e.ez}`, measuredGrade(e, input.metric, quality.limits)])) : null;
  const gradeOf = (hex: number, ex: number, ey: number, ez: number) => grades?.get(`${hex}:${ex}:${ey}:${ez}`) ?? 'excellent';
  const isBad = (hex: number, ex: number, ey: number, ez: number): boolean => gradeOf(hex, ex, ey, ez) !== 'excellent';
  const colorOf = (hex: number, ex: number, ey: number, ez: number): THREE.Color =>
    new THREE.Color(grades ? RESULT_COLORS[resultOf(gradeOf(hex, ex, ey, ez))] : BODY_COLOR);

  // ---- the cut: a clipping plane and the side of it that is kept ----
  const cut = input.section;
  const size = (() => {
    let low = Infinity, high = -Infinity;
    for (const n of state.nodes) for (const c of [n.x, n.y, n.z]) { low = Math.min(low, c); high = Math.max(high, c); }
    return Math.max(1e-9, high - low);
  })();
  const layer = cut ? size * 1e-3 * (cut.keep === 'above' ? -1 : 1) : 0;         // towards the removed side
  const clip: THREE.Plane[] = [];
  let keptTest = (_point: THREE.Vector3): boolean => true;
  if (cut) {
    const slack = planeSlack(cut);
    const normal = new THREE.Vector3();
    normal.setComponent(cut.axis, cut.keep === 'above' ? 1 : -1);
    // what is within a hair of the plane stays (the faces that lie in it belong to the kept side)
    const plane = new THREE.Plane(normal, cut.keep === 'above' ? -(cut.at - slack) : cut.at + slack);
    clip.push(plane);
    keptTest = point => plane.distanceToPoint(point) >= 0;
  }

  const hexById = new Map(state.hexes.map(h => [h.id, h]));
  const shown = new Map<string, boolean>();
  const visible = (hex: number, ex: number, ey: number, ez: number): boolean => {
    const key = `${hex}:${ex}:${ey}:${ez}`;
    let result = shown.get(key);
    if (result === undefined) {
      result = true;
      if (input.onlyBad && grades && !isBad(hex, ex, ey, ez)) result = false;
      if (result && cut) {
        // an element stays while any part of it is on the kept side: the ones the plane runs through are cut by it
        const { min, max } = geometry.elementExtent(hexById.get(hex)!, ex, ey, ez, cut.axis);
        const slack = planeSlack(cut);
        result = cut.keep === 'above' ? max > cut.at + slack : min < cut.at - slack;
      }
      shown.set(key, result);
    }
    return result;
  };

  // the nearer edges and dots of a see-through body are strong, the farther ones faint
  const bounds = new THREE.Box3();
  for (const n of state.nodes) bounds.expandByPoint(new THREE.Vector3(n.x, n.y, n.z));
  const sphere = bounds.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-3);
  const fadeUniforms: FadeUniforms = { uFadeNear: { value: 0 }, uFadeFar: { value: 1 }, uFadeMin: { value: seeThrough ? FAR_ALPHA : 1 } };
  const fade = createDepthFade(sphere.center, radius, seeThrough ? FAR_ALPHA : 1);

  const faces = drawnFaces(state, geometry, visible, isBad, seeThrough);
  const pickables: THREE.Object3D[] = [];

  // ---- the faces ----
  const surface = (subset: readonly DrawnFace[], withUv: boolean): THREE.BufferGeometry => {
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    for (const face of subset) {
      const colour = colorOf(face.owner.id, ...face.element);
      appendSurface(positions, indices, geometry.smallFace(face.drawer, face.axis, face.t, face.p, face.q), resolution, (u, v) => {
        colors.push(colour.r, colour.g, colour.b);
        uvs.push(u, v);
      });
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    buffer.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    if (withUv) buffer.setAttribute('faceUv', new THREE.Float32BufferAttribute(uvs, 2));
    buffer.setIndex(indices);
    buffer.computeVertexNormals();
    return buffer;
  };

  if (faces.length > 0) {
    const faceGeometry = surface(faces, true);
    const faceMesh = new THREE.Mesh(faceGeometry, litFaceMaterial({ transparent: seeThrough, opacity, solid, clip }, seeThrough ? 0.9 : 1, fadeUniforms));
    faceMesh.renderOrder = 1;
    trackFade(faceMesh, fadeUniforms, sphere.center, radius);
    // a click lands on a triangle; its small face is the triangle's number divided by the triangles of one small face
    faceMesh.userData['resolvePick'] = (triangle: number): PickedFace | null => {
      const face = faces[Math.floor(triangle / trianglesPerFace)];
      return face ? { kind: 'face', hex: face.owner.id, face: face.face, p: face.p, q: face.q, element: face.element, inner: !face.outer } : null;
    };
    faceMesh.userData['pick'] = faceMesh.userData['resolvePick'](0);
    // what the plane cut away cannot be clicked on, though the ray still passes through it
    if (cut) {
      const raycast = faceMesh.raycast.bind(faceMesh);
      faceMesh.raycast = (raycaster, intersects) => {
        const before = intersects.length;
        raycast(raycaster, intersects);
        for (let i = intersects.length - 1; i >= before; i--) if (!keptTest(intersects[i].point)) intersects.splice(i, 1);
      };
    }
    root.add(faceMesh);
    pickables.push(faceMesh);

    // a see-through outside also writes depth, invisibly, before the dots and the lines: what is in front of them is then known
    if (seeThrough) {
      const outer = faces.filter(f => f.outer);
      if (outer.length > 0) {
        const depthOnly = new THREE.Mesh(
          outer.length === faces.length ? faceGeometry : surface(outer, false),
          new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide, clippingPlanes: clip })
        );
        depthOnly.renderOrder = 0;
        root.add(depthOnly);
      }
    }
  }

  // ---- the nodes: the cube's corners (white) and midpoints (yellow) as dots, the nodes of the small elements between them as small dots ----
  const keyOf = (v: THREE.Vector3) => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
  const cubeNodes = new Map<string, 'corner' | 'mid'>();
  for (const hex of state.hexes) {
    hex.nodeIds.forEach((id, slot) => {
      const node = state.nodes.find(n => n.id === id);
      if (node) cubeNodes.set(keyOf(new THREE.Vector3(node.x, node.y, node.z)), slot < 8 ? 'corner' : 'mid');
    });
  }
  const found = new Map<string, { at: THREE.Vector3; kind: 'corner' | 'mid' | 'sub' }>();
  for (const face of faces) {
    const small = geometry.smallFace(face.drawer, face.axis, face.t, face.p, face.q);
    for (const v of small.positions) {
      const key = keyOf(v);
      if (!found.has(key)) found.set(key, { at: v, kind: cubeNodes.get(key) ?? 'sub' });
    }
  }
  const dotSet = (kind: 'corner' | 'mid' | 'sub', ghosted: boolean): THREE.Object3D | null => {
    // what the body hides shows through only as the cubes' corners: the midpoints and the small elements' nodes behind it would drown the picture
    if (ghosted && kind !== 'corner') return null;
    const points = Array.from(found.values()).filter(f => f.kind === kind);
    if (points.length === 0) return null;
    const material = (colour: number) =>
      ghosted
        ? new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: ghost, depthTest: false, clippingPlanes: clip })
        : new THREE.MeshBasicMaterial({ color: colour, transparent: seeThrough, clippingPlanes: clip });
    if (kind === 'sub') {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap(f => [f.at.x, f.at.y, f.at.z]), 3));
      const pointMaterial = new THREE.PointsMaterial({
        color: SUB_NODE_COLOR, size: SUB_NODE_SIZE, sizeAttenuation: true, transparent: seeThrough, opacity: ghosted ? ghost : 1, depthTest: !ghosted, clippingPlanes: clip
      });
      fade.patch(pointMaterial);
      const dots = new THREE.Points(g, pointMaterial);
      dots.renderOrder = ghosted ? 4 : 3;
      fade.track(dots);
      return dots;
    }
    const sphereMaterial = material(kind === 'corner' ? CORNER_COLOR : MIDPOINT_COLOR);
    fade.patch(sphereMaterial);
    const spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(kind === 'corner' ? CORNER_RADIUS : MIDPOINT_RADIUS, ...DOT_SPHERE_SEGMENTS), sphereMaterial, points.length);
    fade.track(spheres);
    const placed = new THREE.Object3D();
    points.forEach((f, i) => {
      placed.position.copy(f.at);
      placed.updateMatrix();
      spheres.setMatrixAt(i, placed.matrix);
    });
    spheres.instanceMatrix.needsUpdate = true;
    spheres.renderOrder = ghosted ? 4 : 3;
    return spheres;
  };
  for (const kind of ['corner', 'mid', 'sub'] as const) {
    const front = dotSet(kind, false);
    if (front) root.add(front);
    if (ghost > 0.01) {
      const behind = dotSet(kind, true);
      if (behind) root.add(behind);
    }
  }

  // ---- the cut itself: for every element the plane runs through, the polygon in which it cuts it, in the colour of the element ----
  if (cut) {
    const capPositions: number[] = [];
    const capColors: number[] = [];
    const outline: number[] = [];
    const slack = planeSlack(cut);
    for (const hex of state.hexes) {
      for (let ex = 0; ex < counts[0]; ex++)
        for (let ey = 0; ey < counts[1]; ey++)
          for (let ez = 0; ez < counts[2]; ez++) {
            if (!visible(hex.id, ex, ey, ez)) continue;
            const { min, max } = geometry.elementExtent(hex, ex, ey, ez, cut.axis);
            if (!(min < cut.at - slack && max > cut.at + slack)) continue;
            const e = [ex, ey, ez];
            const sixFaces: { positions: number[]; indices: number[] }[] = [];
            for (let axis = 0; axis < 3; axis++) {
              const [t0, t1] = [0, 1, 2].filter(d => d !== axis);
              for (const t of [e[axis], e[axis] + 1]) {
                const positions: number[] = [];
                const indices: number[] = [];
                appendSurface(positions, indices, geometry.smallFace(hex, axis, t, e[t0], e[t1]), resolution);
                sixFaces.push({ positions, indices });
              }
            }
            const loops = elementSectionLoops(sixFaces, cut);
            if (loops.length === 0) continue;
            const rgb = colorOf(hex.id, ex, ey, ez);
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
    if (capPositions.length > 0) {
      // a hair into the body: the outline and the sheet of the plane lie in front of it
      const into = (values: number[], by: number) => values.map((v, i) => (i % 3 === cut.axis ? v + by : v));
      const capGeometry = new THREE.BufferGeometry();
      capGeometry.setAttribute('position', new THREE.Float32BufferAttribute(into(capPositions, -layer), 3));
      capGeometry.setAttribute('color', new THREE.Float32BufferAttribute(capColors, 3));
      capGeometry.computeVertexNormals();
      const capMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: seeThrough, opacity, depthWrite: solid, depthTest: solid });
      const cap = new THREE.Mesh(capGeometry, capMaterial);
      cap.renderOrder = 1;
      cap.userData['sectionCap'] = true;
      root.add(cap);
    }
    if (outline.length > 0) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(outline, 3));
      const lineMaterial = new THREE.LineBasicMaterial({ color: CAP_OUTLINE_COLOR });
      createDepthFade(new THREE.Vector3(), 1, 1).patch(lineMaterial);
      const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
      lines.renderOrder = 2;
      lines.userData['sectionStructure'] = true;
      root.add(lines);
    }
    // the plane, as a pale sheet with an outline, behind the cut itself
    const sheet = sectionPlane(state, { ...cut, at: cut.at - 2 * layer });
    sheet.userData['sectionPlane'] = true;
    root.add(sheet);
  }

  // ---- what is clamped and what is pressed, on the outside faces ----
  const fixed = new Set((setup?.fixed ?? []).map(f => `${f.hex}:${f.face}:${f.p}:${f.q}`));
  const pressure = new Map((setup?.loads ?? []).map(l => [`${l.hex}:${l.face}:${l.p}:${l.q}`, l.pressure]));
  const everyPressure = Array.from(pressure.values());
  const keyOfFace = (face: DrawnFace) => `${face.owner.id}:${face.face}:${face.p}:${face.q}`;
  const coats: { color: number; faces: DrawnFace[] }[] = [];
  for (const face of faces) {
    if (!face.outer) continue;
    if (input.showFixed && fixed.has(keyOfFace(face))) coats.push({ color: FIXED_COLOR, faces: [face] });
    if (input.showLoads && pressure.has(keyOfFace(face))) coats.push({ color: LOAD_COLOR, faces: [face] });
  }
  for (const color of [FIXED_COLOR, LOAD_COLOR]) {
    const coated = coats.filter(c => c.color === color).flatMap(c => c.faces);
    if (coated.length === 0) continue;
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    for (const face of coated) {
      const rgb = new THREE.Color(color === LOAD_COLOR ? pressureColor(everyPressure, pressure.get(keyOfFace(face)) ?? 0) : color);
      appendSurface(positions, indices, geometry.smallFace(face.drawer, face.axis, face.t, face.p, face.q), resolution, () => colors.push(rgb.r, rgb.g, rgb.b));
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    buffer.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    buffer.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: OVERLAY_OPACITY, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: clip });
    createDepthFade(new THREE.Vector3(), 1, 1).patch(material);
    const coat = new THREE.Mesh(buffer, material);
    coat.renderOrder = 5;
    root.add(coat);
  }

  // the pressure written on the pressed faces: one label per cube side and pressure
  if (input.showLoads && !cut && pressure.size > 0) {
    const groups = new Map<string, { text: string; points: THREE.Vector3[]; normals: THREE.Vector3[]; area: number }>();
    const everyPoint: THREE.Vector3[] = [];
    for (const face of faces) {
      if (!face.outer) continue;
      const value = pressure.get(keyOfFace(face));
      if (value === undefined) continue;
      const small = geometry.smallFace(face.drawer, face.axis, face.t, face.p, face.q);
      const centre = facePoint(small, 0, 0);
      const spanned = facePoint(small, 1, 0).sub(facePoint(small, -1, 0)).cross(facePoint(small, 0, 1).sub(facePoint(small, 0, -1)));
      const area = spanned.length();
      const normal = spanned.normalize();
      const group = `${face.owner.id}:${face.face}:${value}`;
      const entry = groups.get(group) ?? { text: `${Number((value / 1e6).toPrecision(3))} МПа`, points: [], normals: [], area: 0 };
      entry.points.push(centre);
      entry.normals.push(normal);
      entry.area += area;
      groups.set(group, entry);
      everyPoint.push(centre);
    }
    if (everyPoint.length > 0) {
      const box = new THREE.Box3().setFromPoints(everyPoint);
      const body = box.getCenter(new THREE.Vector3());
      const bodySize = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6);
      for (const entry of groups.values()) {
        const height = Math.min(bodySize * 0.15, Math.max(bodySize * 0.006, Math.sqrt(entry.area) / 6));
        const centre = entry.points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(entry.points.length);
        const normal = entry.normals.reduce((sum, n) => sum.add(n), new THREE.Vector3()).normalize();
        if (normal.dot(centre.clone().sub(body)) < 0) normal.negate();
        root.add(pressureLabel(entry.text, centre.add(normal.multiplyScalar(height * 0.6)), height));
      }
    }
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

  root.traverse(o => (o.frustumCulled = false));
  return { root, pickables, nodeMeshes: new Map(), setHighlight };
}
