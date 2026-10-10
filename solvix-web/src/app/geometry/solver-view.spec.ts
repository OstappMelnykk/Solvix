import * as THREE from 'three';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import { SolverQualityDto, SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { LOCAL_COORDS, PickedFace, disposeMeshView, mapHex } from './mesh-editor-view';
import { GRADE_COLORS, SolverViewInput, buildHighlight, buildSolverView, faceName, faceResolution, fieldRange, fieldValues, gridPoints, materialColor, pressureColor, rampColor } from './solver-view';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

const setup = (over: Partial<SolverSetupDto> = {}): SolverSetupDto => ({
  version: 0,
  divisions: [1, 1, 1],
  materials: [],
  defaultMaterial: 'steel',
  hexMaterials: {},
  elementMaterials: [],
  fixed: [],
  loads: [],
  ...over
});

// A result for a state, every cube with nodes of its own at the grid points of its division; `at` gives the
// displacement and the stress of a node from where it sits.
const resultFor = (
  state: MeshStateDto,
  divisions: [number, number, number],
  at: (x: number, y: number, z: number) => { u?: [number, number, number]; vm?: number } = () => ({})
): SolverResultDto => {
  const [nx, ny, nz] = divisions;
  const points = gridPoints(nx, ny, nz);
  const nodes = new Map(state.nodes.map(n => [n.id, n]));
  const positions: number[] = [];
  const ux: number[] = [], uy: number[] = [], uz: number[] = [], vm: number[] = [], gridNodes: number[] = [];
  for (const hex of state.hexes) {
    const slots = LOCAL_COORDS.map((_, s) => new THREE.Vector3(nodes.get(hex.nodeIds[s])!.x, nodes.get(hex.nodeIds[s])!.y, nodes.get(hex.nodeIds[s])!.z));
    for (const [ix, iy, iz] of points) {
      const p = mapHex(slots, ix / nx - 1, iy / ny - 1, iz / nz - 1);
      const value = at(p.x, p.y, p.z);
      gridNodes.push(positions.length / 3);
      positions.push(p.x, p.y, p.z);
      ux.push(value.u?.[0] ?? 0); uy.push(value.u?.[1] ?? 0); uz.push(value.u?.[2] ?? 0); vm.push(value.vm ?? 0);
    }
  }
  return { ticket: 1, divisions, positions, hexIds: state.hexes.map(h => h.id), gridNodes, ux, uy, uz, vonMises: vm, maxDisplacement: 0, maxVonMises: 0, elapsedSeconds: 0 };
};

const input = (over: Partial<SolverViewInput> = {}): SolverViewInput => ({
  state: linkedPairState(),
  setup: setup(),
  result: null,
  field: 'vonMises',
  deformationScale: 1,
  opacity: 1,
  ...over
});

const resolutionOf = faceResolution;
const meshes = (root: THREE.Object3D) => root.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
const cubeMeshes = (view: ReturnType<typeof buildSolverView>) => view.pickables as THREE.Mesh[];
const overlays = (view: ReturnType<typeof buildSolverView>) => meshes(view.root).filter(m => !view.pickables.includes(m));
const picksOf = (mesh: THREE.Mesh, divisions: readonly number[] = [1, 1, 1]): PickedFace[] => {
  const triangles = 2 * resolutionOf(divisions) ** 2;
  const count = mesh.geometry.getIndex()!.count / 3 / triangles;
  return Array.from({ length: count }, (_, i) => (mesh.userData['resolvePick'] as (t: number) => PickedFace)(i * triangles));
};
const allPicks = (view: ReturnType<typeof buildSolverView>, divisions: readonly number[] = [1, 1, 1]) => cubeMeshes(view).flatMap(m => picksOf(m, divisions));
const lineVertexCount = (view: ReturnType<typeof buildSolverView>) =>
  (view.root.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments).geometry.getAttribute('position').count;

// the colour (first vertex) and position (first vertex) of the small face of a cube that has this face name and cell
const faceVertex = (view: ReturnType<typeof buildSolverView>, hex: number, face: string, divisions: readonly number[] = [1, 1, 1], p = 0, q = 0) => {
  const r = resolutionOf(divisions);
  const stride = (r + 1) ** 2;
  for (const mesh of cubeMeshes(view)) {
    const picks = picksOf(mesh, divisions);
    const at = picks.findIndex(pick => pick.hex === hex && pick.face === face && pick.p === p && pick.q === q);
    if (at < 0) continue;
    const colors = mesh.geometry.getAttribute('color');
    const positions = mesh.geometry.getAttribute('position');
    return { color: new THREE.Color(colors.getX(at * stride), colors.getY(at * stride), colors.getZ(at * stride)), position: new THREE.Vector3(positions.getX(at * stride), positions.getY(at * stride), positions.getZ(at * stride)), mesh };
  }
  throw new Error(`no small face ${hex} ${face} ${p},${q}`);
};

describe('solver-view', () => {
  describe('colours', () => {
    it('the ramp runs from blue to red and clamps what is outside', () => {
      expect(rampColor(0).getHex()).toBe(0x2b3cc4);
      expect(rampColor(1).getHex()).toBe(0xe4572e);
      expect(rampColor(-5).getHex()).toBe(rampColor(0).getHex());
      expect(rampColor(7).getHex()).toBe(rampColor(1).getHex());
      expect(rampColor(NaN).getHex()).toBe(rampColor(0).getHex());
      expect(rampColor(0.5).getHex()).not.toBe(rampColor(0).getHex());
    });

    it('the ready-made materials have colours of their own, and a custom one a stable colour', () => {
      expect(materialColor('steel').getHex()).not.toBe(materialColor('rubber').getHex());
      expect(materialColor('rubber').getHex()).toBe(0xe0605a);
      expect(materialColor('custom-glass').getHex()).toBe(materialColor('custom-glass').getHex());
      expect(materialColor('custom-glass').getHex()).not.toBe(materialColor('custom-wood').getHex());
    });
  });

  describe('fields', () => {
    const result = { ...resultFor(singleCubeState(), [1, 1, 1]), ux: [3, 0], uy: [4, 0], uz: [0, 2], vonMises: [10, 30] } as SolverResultDto;

    it('von Mises values come straight from the result, displacement as the length of the vector', () => {
      expect(fieldValues(result, 'vonMises')).toEqual([10, 30]);
      expect(fieldValues(result, 'displacement')).toEqual([5, 2]);
      expect(fieldValues(result, 'none')).toBeNull();
    });

    it('the range of a field, and of nothing', () => {
      expect(fieldRange([3, 1, 2])).toEqual({ min: 1, max: 3 });
      expect(fieldRange([])).toEqual({ min: 0, max: 0 });
    });
  });

  describe('the grid of a divided cube', () => {
    it('lists the points with at most one odd index, iz slowest and ix fastest', () => {
      const points = gridPoints(1, 1, 1);

      expect(points.length).toBe(20);
      expect(points[0]).toEqual([0, 0, 0]);
      expect(points[1]).toEqual([1, 0, 0]);
      expect(points[2]).toEqual([2, 0, 0]);
      expect(points.every(([x, y, z]) => (x % 2) + (y % 2) + (z % 2) <= 1)).toBeTrue();
      expect(gridPoints(2, 2, 2).length).toBe(81);
      expect(gridPoints(2, 1, 3).length).toBe(70);
    });

    it('names a face by its axis and side', () => {
      expect([faceName(0, false), faceName(0, true), faceName(1, true), faceName(2, false)]).toEqual(['XMinus', 'XPlus', 'YPlus', 'ZMinus']);
    });
  });

  describe('the faces that are drawn', () => {
    it('are the outer faces: 5 per cube of a linked pair, the shared one left out', () => {
      const view = buildSolverView(input());
      const picks = allPicks(view);

      expect(cubeMeshes(view).length).toBe(2);                       // one mesh per cube
      expect(picks.length).toBe(10);
      expect(picks.every(p => p.kind === 'face' && p.inner === false)).toBeTrue();
      expect(picks.some(p => p.hex === 0 && p.face === 'XPlus')).toBeFalse();
      expect(picks.some(p => p.hex === 1 && p.face === 'XMinus')).toBeFalse();
      expect(view.nodeMeshes.size).toBe(0);
      disposeMeshView(view);
    });

    it('a click on a triangle resolves to the small face it belongs to: its cube, side, cell and element', () => {
      const view = buildSolverView(input({ state: singleCubeState(), setup: setup({ divisions: [2, 1, 3] }) }));
      const mesh = cubeMeshes(view)[0];
      const triangles = 2 * resolutionOf([2, 1, 3]) ** 2;
      const resolve = mesh.userData['resolvePick'] as (t: number) => PickedFace | null;

      const zPlus = picksOf(mesh, [2, 1, 3]).filter(p => p.face === 'ZPlus');
      expect(zPlus.map(p => [p.p, p.q])).toEqual([[0, 0], [1, 0]]);
      expect(zPlus.map(p => p.element)).toEqual([[0, 0, 2], [1, 0, 2]]);          // the top layer
      const xMinus = picksOf(mesh, [2, 1, 3]).filter(p => p.face === 'XMinus');
      expect(xMinus.map(p => p.element)).toEqual([[0, 0, 0], [0, 0, 1], [0, 0, 2]]);
      expect(resolve(0)).toEqual(jasmine.objectContaining({ hex: 0, kind: 'face' }));
      expect(resolve(triangles * 1000)).toBeNull();                              // past the last face
      expect(mesh.userData['pick']).toEqual(resolve(0));
      disposeMeshView(view);
    });

    it('cuts every side into the small faces of the division, with their own edges', () => {
      const view = buildSolverView(input({ state: singleCubeState(), setup: setup({ divisions: [2, 1, 3] }) }));

      // sides: X 1*3 cells x2, Y 2*3 x2, Z 2*1 x2 = 22 small faces, 4 edges each, 8 segments of 2 vertices
      expect(allPicks(view, [2, 1, 3]).length).toBe(22);
      expect(lineVertexCount(view)).toBe(22 * 4 * 8 * 2);
      disposeMeshView(view);
    });

    it('the small faces of a side lie where the division puts them', () => {
      const view = buildSolverView(input({ state: singleCubeState(), setup: setup({ divisions: [2, 1, 1] }) }));

      const first = faceVertex(view, 0, 'ZPlus', [2, 1, 1], 0, 0).position;
      const second = faceVertex(view, 0, 'ZPlus', [2, 1, 1], 1, 0).position;

      expect(first.x).toBeCloseTo(0, 6);
      expect(second.x).toBeCloseTo(0.5, 6);                          // the second small face starts half way along x
      expect(first.z).toBeCloseTo(1, 6);
      disposeMeshView(view);
    });

    it('with "inner faces" also the faces between visible elements, once each', () => {
      const plain = buildSolverView(input({ state: singleCubeState(), setup: setup({ divisions: [2, 1, 1] }) }));
      const inner = buildSolverView(input({ state: singleCubeState(), setup: setup({ divisions: [2, 1, 1] }), showInner: true }));

      expect(allPicks(plain, [2, 1, 1]).length).toBe(10);
      const picks = allPicks(inner, [2, 1, 1]);
      expect(picks.length).toBe(11);                                  // + the one plane between the two elements
      expect(picks.filter(p => p.inner).length).toBe(1);
      [plain, inner].forEach(disposeMeshView);
    });

    it('with "inner faces", the shared face of two linked cubes is drawn once, from the lower cube', () => {
      const view = buildSolverView(input({ showInner: true }));
      const picks = allPicks(view);

      expect(picks.length).toBe(11);
      expect(picks.filter(p => p.inner).length).toBe(1);
      disposeMeshView(view);
    });
  });

  describe('hiding materials', () => {
    it('does not draw the elements of a hidden material, and shows the faces of what was behind them', () => {
      const state = linkedPairState();
      const view = buildSolverView(input({ state, setup: setup({ hexMaterials: { '1': 'rubber' } }), hiddenMaterials: new Set(['steel']) }));
      const picks = allPicks(view);

      // cube 1 (rubber): its 5 outer faces + the face it shares with the hidden steel cube, which is now exposed
      expect(picks.every(p => p.hex === 1)).toBeTrue();
      expect(picks.length).toBe(6);
      const exposed = picks.find(p => p.face === 'XMinus')!;
      expect(exposed.inner).toBeTrue();                                // it is inside the body, though now visible
      expect(exposed.element).toEqual([0, 0, 0]);
      disposeMeshView(view);
    });

    it('hides a material by element, not only by cube', () => {
      const view = buildSolverView(input({
        state: singleCubeState(),
        setup: setup({ divisions: [2, 1, 1], elementMaterials: [{ hex: 0, ex: 1, ey: 0, ez: 0, material: 'rubber' }] }),
        hiddenMaterials: new Set(['rubber'])
      }));

      const picks = allPicks(view, [2, 1, 1]);

      expect(picks.every(p => p.element![0] === 0)).toBeTrue();         // only the steel element is left
      expect(picks.length).toBe(6);                                      // its 5 outer faces + the plane towards the hidden element
      disposeMeshView(view);
    });

    it('hides everything when every material is hidden', () => {
      const view = buildSolverView(input({ hiddenMaterials: new Set(['steel']) }));

      expect(cubeMeshes(view)).toEqual([]);
      expect(view.root.children.filter(c => c instanceof THREE.LineSegments).length).toBe(0);
      disposeMeshView(view);
    });
  });

  describe('colours of the elements', () => {
    it('colours an element by its material: its own, or its cube\'s', () => {
      const view = buildSolverView(input({
        setup: setup({ hexMaterials: { '1': 'concrete' }, elementMaterials: [] })
      }));

      const steel = faceVertex(view, 0, 'YPlus').color;
      const concrete = faceVertex(view, 1, 'YPlus').color;

      expect(steel.getHex()).not.toBe(concrete.getHex());
      expect(steel.r).toBeLessThanOrEqual(materialColor('steel').r + 1e-6);          // shading only darkens
      disposeMeshView(view);
    });

    it('one element of a cube can have a colour of its own', () => {
      const view = buildSolverView(input({
        state: singleCubeState(),
        setup: setup({ divisions: [2, 1, 1], elementMaterials: [{ hex: 0, ex: 1, ey: 0, ez: 0, material: 'rubber' }] })
      }));

      const left = faceVertex(view, 0, 'ZPlus', [2, 1, 1], 0, 0).color;
      const right = faceVertex(view, 0, 'ZPlus', [2, 1, 1], 1, 0).color;

      expect(left.getHex()).not.toBe(right.getHex());
      expect(right.r).toBeGreaterThan(right.b);                           // the rubber one is reddish
      disposeMeshView(view);
    });

    it('is shaded by a fixed light: sides turned differently are not the same brightness', () => {
      const view = buildSolverView(input({ state: singleCubeState() }));

      const brightness = (face: string) => {
        const c = faceVertex(view, 0, face).color;
        return c.r + c.g + c.b;
      };

      expect(new Set(['XMinus', 'XPlus', 'YPlus', 'ZPlus'].map(f => brightness(f).toFixed(3))).size).toBeGreaterThan(1);
      disposeMeshView(view);
    });
  });

  describe('clamped and pressed faces', () => {
    it('overlays them in blue and green, small face by small face', () => {
      const plain = buildSolverView(input());
      const marked = buildSolverView(input({
        setup: setup({ fixed: [{ hex: 0, face: 'XMinus', p: 0, q: 0 }], loads: [{ hex: 1, face: 'XPlus', pressure: -1e6, p: 0, q: 0 }] })
      }));

      expect(overlays(plain).length).toBe(0);
      const colours = overlays(marked).map(m => new THREE.Color(m.geometry.getAttribute('color').getX(0), m.geometry.getAttribute('color').getY(0), m.geometry.getAttribute('color').getZ(0)).getHex());
      expect(colours.length).toBe(2);
      expect(colours).toContain(0x3388ff);
      expect(colours).toContain(0x44ff44);
      [plain, marked].forEach(disposeMeshView);
    });

    it('draws the supports and the loads independently of each other, and none when both are switched off', () => {
      const setupWithBoth = setup({ fixed: [{ hex: 0, face: 'XMinus', p: 0, q: 0 }], loads: [{ hex: 1, face: 'XPlus', pressure: -1e6, p: 0, q: 0 }] });
      const colourOfOverlay = (m: THREE.Mesh) => new THREE.Color(m.geometry.getAttribute('color').getX(0), m.geometry.getAttribute('color').getY(0), m.geometry.getAttribute('color').getZ(0)).getHex();
      const onlyLoads = buildSolverView(input({ setup: setupWithBoth, showFixed: false }));
      const onlyFixed = buildSolverView(input({ setup: setupWithBoth, showLoads: false }));
      const neither = buildSolverView(input({ setup: setupWithBoth, showFixed: false, showLoads: false }));

      expect(overlays(onlyLoads).map(colourOfOverlay)).toEqual([0x44ff44]);
      expect(overlays(onlyFixed).map(colourOfOverlay)).toEqual([0x3388ff]);
      expect(overlays(neither).length).toBe(0);
      [onlyLoads, onlyFixed, neither].forEach(disposeMeshView);
    });

    it('marks only the small faces that carry something: one of the two cells of a side', () => {
      const view = buildSolverView(input({
        state: singleCubeState(),
        setup: setup({ divisions: [2, 1, 1], loads: [{ hex: 0, face: 'ZPlus', pressure: -1e6, p: 1, q: 0 }] })
      }));

      const overlay = overlays(view)[0];
      const stride = (resolutionOf([2, 1, 1]) + 1) ** 2;

      expect(overlay.geometry.getAttribute('position').count).toBe(stride);        // exactly one small face
      expect(overlay.geometry.getAttribute('position').getX(0)).toBeCloseTo(0.5, 6);
      view.root.clear();
    });

    it('does not overlay a face inside the body', () => {
      const view = buildSolverView(input({ setup: setup({ fixed: [{ hex: 0, face: 'XPlus', p: 0, q: 0 }] }) }));

      expect(overlays(view).length).toBe(0);
      disposeMeshView(view);
    });
  });

  describe('after a solve', () => {
    it('colours by the field: the highest value is red, the lowest blue, and it varies across a face', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], (_x, _y, z) => ({ vm: z * 1e6 }));        // stress grows with height

      const view = buildSolverView(input({ state, result, field: 'vonMises' }));

      const top = faceVertex(view, 0, 'ZPlus').color;
      const bottom = faceVertex(view, 0, 'ZMinus').color;
      expect(top.r).toBeGreaterThan(top.b * 2);                    // red at the highest value (shading only darkens it a little)
      expect(bottom.b).toBeGreaterThan(bottom.r * 2);              // blue at the lowest
      const side = faceVertex(view, 0, 'XPlus');
      const colors = side.mesh.geometry.getAttribute('color');
      const values = new Set<string>();
      for (let i = 0; i < colors.count; i++) values.add(colors.getX(i).toFixed(3));
      expect(values.size).toBeGreaterThan(3);                                          // a gradient, not one colour
      disposeMeshView(view);
    });

    it('colours the small faces from the nodes of the divided mesh', () => {
      const state = singleCubeState();
      const result = resultFor(state, [2, 1, 1], x => ({ vm: x * 1e6 }));

      const view = buildSolverView(input({ state, result, setup: setup({ divisions: [2, 1, 1] }) }));

      const left = faceVertex(view, 0, 'ZPlus', [2, 1, 1], 0, 0).color;
      const right = faceVertex(view, 0, 'ZPlus', [2, 1, 1], 1, 0).color;
      expect(right.r).toBeGreaterThan(left.r);
      disposeMeshView(view);
    });

    it('"materials" as the field keeps the material colours even with a result', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ vm: 5e6 }));

      const view = buildSolverView(input({ state, result, field: 'none' }));

      expect(faceVertex(view, 0, 'YPlus').color.b).toBeGreaterThan(faceVertex(view, 0, 'YPlus').color.r);       // steel: blue-grey, not the ramp's red
      disposeMeshView(view);
    });

    it('draws the body deformed by the displacement times the scale, and not at all with scale 0 or without a result', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ u: [0, 0, 0.1] }));
      const topZ = (v: ReturnType<typeof buildSolverView>) => faceVertex(v, 0, 'ZPlus').position.z;

      const shifted = buildSolverView(input({ state, result, deformationScale: 5 }));
      const still = buildSolverView(input({ state, result, deformationScale: 0 }));
      const none = buildSolverView(input({ state, result: null }));

      expect(topZ(shifted)).toBeCloseTo(1.5, 5);
      expect(topZ(still)).toBeCloseTo(1, 5);
      expect(topZ(none)).toBeCloseTo(1, 5);
      [shifted, still, none].forEach(disposeMeshView);
    });

    it('moves the vertices in place to any scale, the same as a rebuilt view would have them', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ u: [0, 0, 0.1] }));
      const topZ = (v: ReturnType<typeof buildSolverView>) => faceVertex(v, 0, 'ZPlus').position.z;

      const view = buildSolverView(input({ state, result, deformationScale: 0 }));
      expect(topZ(view)).toBeCloseTo(1, 5);
      view.setDeformation!(5);
      expect(topZ(view)).toBeCloseTo(1.5, 5);
      view.setDeformation!(0.5);
      expect(topZ(view)).toBeCloseTo(1.05, 5);
      view.setDeformation!(0);
      expect(topZ(view)).toBeCloseTo(1, 5);
      disposeMeshView(view);
    });

    it('re-colours the field for a new top of the range without a rebuild', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ vm: 5e6 }));
      const view = buildSolverView(input({ state, result }));
      const colour = () => Array.from((view.pickables[0] as THREE.Mesh).geometry.getAttribute('color').array.slice(0, 3));

      const full = colour();
      view.setColorRange!(1e7);        // a higher top: the same value sits lower on the ramp
      const capped = colour();
      expect(capped).not.toEqual(full);
      view.setColorRange!(5e6);
      expect(colour()[0]).toBeCloseTo(full[0], 2);
      disposeMeshView(view);
    });

    it('a field that is zero everywhere is one colour, not NaN', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ vm: 0 }));

      const view = buildSolverView(input({ state, result }));

      const colors = cubeMeshes(view)[0].geometry.getAttribute('color');
      expect(Array.from(colors.array).every(Number.isFinite)).toBeTrue();
      disposeMeshView(view);
    });
  });

  describe('see-through', () => {
    const material = (view: ReturnType<typeof buildSolverView>) => cubeMeshes(view)[0].material as THREE.MeshBasicMaterial;

    it('draws the cubes solid at 100%', () => {
      const view = buildSolverView(input({ opacity: 1 }));

      expect(material(view).transparent).toBeFalse();
      expect(material(view).opacity).toBe(1);
      expect(material(view).depthWrite).toBeTrue();
      disposeMeshView(view);
    });

    it('makes them see-through below 100%, without writing depth so the faces behind show', () => {
      const view = buildSolverView(input({ opacity: 0.4 }));

      expect(material(view).transparent).toBeTrue();
      expect(material(view).opacity).toBeCloseTo(0.4, 5);
      expect(material(view).depthWrite).toBeFalse();
      disposeMeshView(view);
    });

    it('is handed to the order-independent transparency pass, so the result does not depend on the draw order', () => {
      const view = buildSolverView(input({ opacity: 0.4 }));

      expect(material(view).userData['weightedOit']).toBeTrue();
      disposeMeshView(view);
    });

    it('never goes fully invisible or beyond solid', () => {
      const faint = buildSolverView(input({ opacity: 0 }));
      const over = buildSolverView(input({ opacity: 3 }));

      expect(material(faint).opacity).toBeGreaterThan(0);
      expect(material(over).opacity).toBe(1);
      disposeMeshView(faint);
      disposeMeshView(over);
    });

    it('keeps the marked faces equally visible whatever the cube opacity', () => {
      const view = buildSolverView(input({ opacity: 0.2, setup: setup({ fixed: [{ hex: 0, face: 'XMinus', p: 0, q: 0 }] }) }));

      expect((overlays(view)[0].material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(0.62, 5);
      disposeMeshView(view);
    });
  });

  describe('the highlight', () => {
    const base = () => input({ state: singleCubeState(), setup: setup({ divisions: [2, 2, 1] }) });
    const none = { faces: [], elements: [], pointed: null };

    it('is empty when there is nothing to show', () => {
      expect(buildHighlight(base(), none).children.length).toBe(0);
    });

    it('draws the small faces a click would mark: a quad and an outline each', () => {
      const group = buildHighlight(base(), { ...none, faces: [{ hex: 0, face: 'ZPlus', p: 1, q: 0 }] });
      const quad = group.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh;
      const lines = group.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments;

      const stride = (faceResolution([2, 2, 1]) + 1) ** 2;
      expect(quad.geometry.getAttribute('position').count).toBe(stride);              // a smooth grid, not four corners
      expect(lines.geometry.getAttribute('position').count).toBe(4 * 6 * 2);          // 4 edges, 6 segments each
      expect(quad.geometry.getAttribute('position').getX(0)).toBeCloseTo(0.5, 6);
      expect(quad.geometry.getAttribute('position').getZ(0)).toBeCloseTo(1, 6);
    });

    it('a whole side without a cell is every small face of it', () => {
      const group = buildHighlight(base(), { ...none, faces: [{ hex: 0, face: 'XMinus' }] });
      const quad = group.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh;

      expect(quad.geometry.getAttribute('position').count).toBe((faceResolution([2, 2, 1]) + 1) ** 2 * (2 * 1));      // ny * nz cells on an X side
    });

    it('outlines the elements a material would be given to: 12 curved edges each', () => {
      const group = buildHighlight(base(), { ...none, elements: [{ hex: 0, ex: 1, ey: 0, ez: 0 }, { hex: 0, ex: 0, ey: 1, ez: 0 }] });
      const lines = group.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments;

      expect(group.children.some(c => c instanceof THREE.Mesh)).toBeFalse();
      expect(lines.geometry.getAttribute('position').count).toBe(2 * 12 * 4 * 2);
    });

    it('also marks the small face that is pointed at', () => {
      const pointed: PickedFace = { kind: 'face', hex: 0, face: 'XPlus', p: 1, q: 0, element: [1, 1, 0], inner: false };

      const group = buildHighlight(base(), { ...none, pointed });
      const quad = group.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh;

      expect(quad.geometry.getAttribute('position').count).toBe((faceResolution([2, 2, 1]) + 1) ** 2);
      expect(quad.geometry.getAttribute('position').getX(0)).toBeCloseTo(1, 6);       // the Plus face of an element at x index 1 of 2: x = 1
    });

    it('never draws more than the limit', () => {
      const elements = Array.from({ length: 50 }, () => ({ hex: 0, ex: 0, ey: 0, ez: 0 }));

      const group = buildHighlight(base(), { ...none, elements }, 10);
      const lines = group.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments;

      expect(lines.geometry.getAttribute('position').count).toBe(10 * 12 * 4 * 2);
    });

    it('is drawn on top of the body and follows a deformed body', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ u: [0, 0, 0.5] }));

      const group = buildHighlight(input({ state, result, deformationScale: 1 }), { ...none, faces: [{ hex: 0, face: 'ZPlus', p: 0, q: 0 }] });
      const quad = group.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh;

      expect(quad.geometry.getAttribute('position').getZ(0)).toBeCloseTo(1.5, 5);
      expect((quad.material as THREE.MeshBasicMaterial).depthTest).toBeFalse();
    });

    it('is put into a view and taken out again, freeing what it drew', () => {
      const view = buildSolverView(base());
      const group = buildHighlight(base(), { ...none, faces: [{ hex: 0, face: 'ZPlus', p: 0, q: 0 }] });
      const quad = group.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh;
      const dispose = spyOn(quad.geometry, 'dispose').and.callThrough();

      view.setHighlight!(group);
      expect(view.root.children).toContain(group);
      view.setHighlight!(null);

      expect(view.root.children).not.toContain(group);
      expect(dispose).toHaveBeenCalled();
      disposeMeshView(view);
    });

    it('replacing one highlight with another frees the first', () => {
      const view = buildSolverView(base());
      const first = buildHighlight(base(), { ...none, faces: [{ hex: 0, face: 'ZPlus', p: 0, q: 0 }] });
      const second = buildHighlight(base(), { ...none, faces: [{ hex: 0, face: 'XMinus' }] });

      view.setHighlight!(first);
      view.setHighlight!(second);

      expect(view.root.children).not.toContain(first);
      expect(view.root.children).toContain(second);
      disposeMeshView(view);
    });
  });
});

describe('the coats over the material', () => {
  const state = singleCubeState();
  // a cube whose top is bulged by moving the midpoint node of one of its top edges: the surface is curved, not flat
  const bulged: MeshStateDto = { ...state, nodes: state.nodes.map(n => (n.id === 14 ? { ...n, z: 1.3 } : n)) };

  const zRange = (positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const zs = Array.from({ length: positions.count }, (_, i) => positions.getZ(i));
    return Math.max(...zs) - Math.min(...zs);
  };

  it('a highlighted small face follows a curved surface instead of cutting across it', () => {
    const group = buildHighlight(input({ state: bulged, setup: setup() }), { faces: [{ hex: 0, face: 'ZPlus', p: 0, q: 0 }], elements: [], pointed: null });
    const quad = group.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh;

    expect(zRange(quad.geometry.getAttribute('position'))).toBeGreaterThan(0.2);      // a flat quad through the four corners would have no height
  });

  it('a clamped face is the same surface as the material under it, vertex for vertex', () => {
    const view = buildSolverView(input({ state: bulged, setup: setup({ fixed: [{ hex: 0, face: 'ZPlus', p: 0, q: 0 }] }) }));
    const coat = overlays(view)[0].geometry.getAttribute('position');
    const material = faceVertex(view, 0, 'ZPlus').mesh.geometry.getAttribute('position');
    const stride = (faceResolution([1, 1, 1]) + 1) ** 2;
    const at = picksOf(cubeMeshes(view)[0]).findIndex(p => p.face === 'ZPlus');

    expect(coat.count).toBe(stride);
    for (let i = 0; i < stride; i++) {
      expect(coat.getX(i)).toBeCloseTo(material.getX(at * stride + i), 6);
      expect(coat.getY(i)).toBeCloseTo(material.getY(at * stride + i), 6);
      expect(coat.getZ(i)).toBeCloseTo(material.getZ(at * stride + i), 6);
    }
    expect(zRange(coat)).toBeGreaterThan(0.2);
    disposeMeshView(view);
  });

  it('a division finer than the face resolution still gets a smooth coat', () => {
    expect(faceResolution([1, 1, 1])).toBe(12);
    expect(faceResolution([8, 8, 8])).toBe(3);
    expect(faceResolution([2, 1, 1])).toBe(6);
  });
});

describe('colouring by mesh quality', () => {
  const quality = (grade0: 'excellent' | 'poor' | 'invalid', grade1: 'excellent' | 'poor' | 'invalid'): SolverQualityDto => ({
    id: 'solvix', name: 'Solvix', source: '', note: '',
    elements: 2,
    grades: { excellent: 0, good: 0, acceptable: 0, poor: 0, invalid: 0 },
    worst: { scaledJacobian: 0.5 },
    limits: [],
    // an excellent element is not flagged
    flagged: [grade0, grade1].flatMap((grade, hex) => (grade === 'excellent' ? [] : [{ hex, ex: 0, ey: 0, ez: 0, grade, values: { scaledJacobian: 0.1 } }]))
  });
  const colourOf = (view: ReturnType<typeof buildSolverView>, hex: number) => {
    const mesh = (view.pickables as THREE.Mesh[]).find(m => (m.userData['pick'] as { hex: number }).hex === hex)!;
    const c = mesh.geometry.getAttribute('color');
    return new THREE.Color(c.getX(0), c.getY(0), c.getZ(0));
  };

  it('has a colour per grade, from green to red', () => {
    expect(GRADE_COLORS.excellent).not.toBe(GRADE_COLORS.poor);
    expect(new THREE.Color(GRADE_COLORS.invalid).r).toBeGreaterThan(new THREE.Color(GRADE_COLORS.invalid).g * 3);
    expect(new THREE.Color(GRADE_COLORS.excellent).g).toBeGreaterThan(new THREE.Color(GRADE_COLORS.excellent).r);
  });

  it('paints each cube with the colour of its grade instead of its material', () => {
    const view = buildSolverView({ state: linkedPairState(), setup: setup(), result: null, field: 'vonMises', deformationScale: 1, opacity: 1, quality: quality('excellent', 'invalid') });

    const good = colourOf(view, 0);
    const bad = colourOf(view, 1);

    expect(good.g).toBeGreaterThan(good.r);                  // green (shading only darkens)
    expect(bad.r).toBeGreaterThan(bad.g * 2);                // red
    disposeMeshView(view);
  });

  it('colours each small element by its own grade, not the whole cube by its worst', () => {
    const state = singleCubeState();
    const q: SolverQualityDto = { ...quality('excellent', 'excellent'), flagged: [{ hex: 0, ex: 1, ey: 0, ez: 0, grade: 'invalid', values: { scaledJacobian: 0.1 } }] };

    const view = buildSolverView({ state, setup: setup({ divisions: [2, 1, 1] }), result: null, field: 'none', deformationScale: 0, opacity: 1, quality: q });
    const colours = new Set<string>();
    const mesh = (view.pickables as THREE.Mesh[])[0];
    const color = mesh.geometry.getAttribute('color');
    for (let i = 0; i < color.count; i++) colours.add(new THREE.Color(color.getX(i), color.getY(i), color.getZ(i)).getHex() > 0 ? (color.getX(i) > color.getY(i) * 2 ? 'red' : 'green') : '');

    expect(colours.has('red')).toBeTrue();
    expect(colours.has('green')).toBeTrue();
    disposeMeshView(view);
  });

  it('wins over the field of a result while it is shown', () => {
    const state = singleCubeState();
    const result = resultFor(state, [1, 1, 1], () => ({ vm: 5e6 }));
    const q = quality('poor', 'poor');

    const view = buildSolverView({ state, setup: setup(), result, field: 'vonMises', deformationScale: 1, opacity: 1, quality: q });

    expect(colourOf(view, 0).r).toBeGreaterThan(colourOf(view, 0).b * 2);        // the grade's orange, not the ramp's blue/red
    disposeMeshView(view);
  });
});

describe('pressureColor', () => {
  it('stays green for one pressure and gives different pressures different colours, weakest green', () => {
    expect(pressureColor([-1e6, -1e6], -1e6)).toBe(0x44ff44);
    const colors = [-1e6, -5e6, -20e6].map(p => pressureColor([-1e6, -5e6, -20e6], p));
    expect(new Set(colors).size).toBe(3);
    expect(colors[0]).toBe(0x44ff44);
  });
});
