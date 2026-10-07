import * as THREE from 'three';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import { SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { LOCAL_COORDS, MeshPick, disposeMeshView, mapHex } from './mesh-editor-view';
import { SolverViewInput, buildSolverView, fieldRange, fieldValues, gridPoints, materialColor, rampColor } from './solver-view';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

const setup = (over: Partial<SolverSetupDto> = {}): SolverSetupDto => ({
  version: 0,
  divisions: [1, 1, 1],
  materials: [],
  defaultMaterial: 'steel',
  hexMaterials: {},
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
  selectedHexes: [],
  ...over
});

const meshes = (root: THREE.Object3D) => root.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
const colorsOf = (mesh: THREE.Mesh) => Array.from(mesh.geometry.getAttribute('color').array);
const positionsOf = (mesh: THREE.Mesh) => Array.from(mesh.geometry.getAttribute('position').array);
const firstColor = (mesh: THREE.Mesh) => new THREE.Color(colorsOf(mesh)[0], colorsOf(mesh)[1], colorsOf(mesh)[2]);
const faceMesh = (view: ReturnType<typeof buildSolverView>, face: string, hex?: number) =>
  view.pickables.find(p => {
    const pick = p.userData['pick'] as { hex: number; face: string };
    return pick.face === face && (hex === undefined || pick.hex === hex);
  }) as THREE.Mesh;
const overlays = (view: ReturnType<typeof buildSolverView>) => meshes(view.root).filter(m => (m.material as THREE.MeshBasicMaterial).transparent && !view.pickables.includes(m));
const lineVertexCount = (view: ReturnType<typeof buildSolverView>) =>
  (view.root.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments).geometry.getAttribute('position').count;

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

    it('a material has the same colour every time and different materials differ', () => {
      expect(materialColor('steel').getHex()).toBe(materialColor('steel').getHex());
      expect(materialColor('steel').getHex()).not.toBe(materialColor('rubber').getHex());
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
  });

  describe('buildSolverView', () => {
    it('draws and offers for picking only the outer faces: the two linked faces inside the pair are left out', () => {
      const view = buildSolverView(input());
      const picks = view.pickables.map(p => p.userData['pick'] as MeshPick);

      expect(picks.length).toBe(10);
      expect(picks.every(p => p.kind === 'face')).toBeTrue();
      expect(picks.some(p => p.kind === 'face' && p.hex === 0 && p.face === 'XPlus')).toBeFalse();
      expect(picks.some(p => p.kind === 'face' && p.hex === 1 && p.face === 'XMinus')).toBeFalse();
      expect(view.nodeMeshes.size).toBe(0);
      disposeMeshView(view);
    });

    it('draws the curved edges of the outer faces as one set of lines: 4 per face, 8 segments each', () => {
      const view = buildSolverView(input());

      expect(view.root.children.filter(c => c instanceof THREE.LineSegments).length).toBe(1);
      expect(lineVertexCount(view)).toBe(10 * 4 * 8 * 2);
      disposeMeshView(view);
    });

    it('cuts every face into the small faces of the division, with their own edges', () => {
      const view = buildSolverView(input({ state: singleCubeState(), setup: setup({ divisions: [2, 1, 3] }) }));

      // faces: X (1*3 small faces) x2, Y (2*3) x2, Z (2*1) x2 = 22 small faces, 4 edges each
      expect(lineVertexCount(view)).toBe(22 * 4 * 8 * 2);
      const zPlus = positionsOf(faceMesh(view, 'ZPlus'));
      const xs = new Set(zPlus.filter((_, i) => i % 3 === 0).map(v => Math.round(v * 1e6) / 1e6));
      expect(xs.has(0.5)).toBeTrue();                     // the line between the two small faces along x
      const ys = new Set(zPlus.filter((_, i) => i % 3 === 1).map(v => Math.round(v * 1e6) / 1e6));
      expect([...ys].every(y => y >= 0 && y <= 1)).toBeTrue();
      disposeMeshView(view);
    });

    it('colours a cube by its material while there is no result', () => {
      const view = buildSolverView(input({ setup: setup({ hexMaterials: { '1': 'rubber' } }) }));

      expect(firstColor(faceMesh(view, 'YPlus', 0)).r).toBeCloseTo(materialColor('steel').r, 5);
      expect(firstColor(faceMesh(view, 'YPlus', 1)).g).toBeCloseTo(materialColor('rubber').g, 5);
      expect(firstColor(faceMesh(view, 'YPlus', 0)).getHex()).not.toBe(firstColor(faceMesh(view, 'YPlus', 1)).getHex());
      disposeMeshView(view);
    });

    it('overlays clamped faces in blue and pressed faces in green, on the faces that carry them only', () => {
      const plain = buildSolverView(input());
      const marked = buildSolverView(input({ setup: setup({ fixed: [{ hex: 0, face: 'XMinus' }], loads: [{ hex: 1, face: 'XPlus', pressure: -1e6 }] }) }));

      expect(overlays(plain).length).toBe(0);
      const colours = overlays(marked).map(m => firstColor(m).getHex());
      expect(colours.length).toBe(2);
      expect(colours).toContain(0x3388ff);
      expect(colours).toContain(0x44ff44);
      disposeMeshView(plain);
      disposeMeshView(marked);
    });

    it('does not overlay a clamped face that is inside the body', () => {
      const view = buildSolverView(input({ setup: setup({ fixed: [{ hex: 0, face: 'XPlus' }] }) }));

      expect(overlays(view).length).toBe(0);
      disposeMeshView(view);
    });

    it('colours by the field after a solve: the highest value is red, the lowest blue, and it varies across a face', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], (_x, _y, z) => ({ vm: z * 1e6 }));        // stress grows with height

      const view = buildSolverView(input({ state, result, field: 'vonMises' }));

      expect(firstColor(faceMesh(view, 'ZPlus')).getHex()).toBe(0xe4572e);
      expect(firstColor(faceMesh(view, 'ZMinus')).getHex()).toBe(0x2b3cc4);
      expect(new Set(colorsOf(faceMesh(view, 'XPlus')).map(c => c.toFixed(3))).size).toBeGreaterThan(3);   // a gradient, not one colour
      disposeMeshView(view);
    });

    it('colours the small faces from the nodes of the divided mesh: a field that changes along x differs between the two halves', () => {
      const state = singleCubeState();
      const result = resultFor(state, [2, 1, 1], x => ({ vm: x * 1e6 }));

      const view = buildSolverView(input({ state, result, setup: setup({ divisions: [2, 1, 1] }) }));
      const colors = colorsOf(faceMesh(view, 'ZPlus'));
      const reds = [];
      for (let i = 0; i < colors.length; i += 3) reds.push(colors[i]);

      expect(Math.max(...reds)).toBeGreaterThan(Math.min(...reds) + 0.2);
      disposeMeshView(view);
    });

    it('"materials" as the field keeps the material colours even with a result', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ vm: 5e6 }));

      const view = buildSolverView(input({ state, result, field: 'none' }));

      expect(firstColor(view.pickables[0] as THREE.Mesh).r).toBeCloseTo(materialColor('steel').r, 5);
      disposeMeshView(view);
    });

    it('draws the body deformed by the displacement times the scale, and not at all with scale 0 or without a result', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ u: [0, 0, 0.1] }));
      const topZ = (v: ReturnType<typeof buildSolverView>) => positionsOf(faceMesh(v, 'ZPlus'))[2];

      const shifted = buildSolverView(input({ state, result, deformationScale: 5 }));
      const still = buildSolverView(input({ state, result, deformationScale: 0 }));
      const none = buildSolverView(input({ state, result: null }));

      expect(topZ(shifted)).toBeCloseTo(1.5, 5);
      expect(topZ(still)).toBeCloseTo(1, 5);
      expect(topZ(none)).toBeCloseTo(1, 5);
      [shifted, still, none].forEach(disposeMeshView);
    });

    it('tints the picked cubes only', () => {
      const plain = buildSolverView(input());
      const picked = buildSolverView(input({ selectedHexes: [0] }));

      expect(firstColor(faceMesh(picked, 'YPlus', 0)).r).not.toBeCloseTo(firstColor(faceMesh(plain, 'YPlus', 0)).r, 3);
      expect(firstColor(faceMesh(picked, 'YPlus', 1)).r).toBeCloseTo(firstColor(faceMesh(plain, 'YPlus', 1)).r, 5);
      disposeMeshView(plain);
      disposeMeshView(picked);
    });

    it('a field that is zero everywhere is one colour, not NaN', () => {
      const state = singleCubeState();
      const result = resultFor(state, [1, 1, 1], () => ({ vm: 0 }));

      const view = buildSolverView(input({ state, result }));

      expect(colorsOf(view.pickables[0] as THREE.Mesh).every(Number.isFinite)).toBeTrue();
      disposeMeshView(view);
    });

    describe('the see-through setting', () => {
      const material = (view: ReturnType<typeof buildSolverView>) => (view.pickables[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;

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

      it('never goes fully invisible or beyond solid', () => {
        const faint = buildSolverView(input({ opacity: 0 }));
        const over = buildSolverView(input({ opacity: 3 }));

        expect(material(faint).opacity).toBeGreaterThan(0);
        expect(material(over).opacity).toBe(1);
        disposeMeshView(faint);
        disposeMeshView(over);
      });

      it('keeps the marked faces equally visible whatever the cube opacity', () => {
        const view = buildSolverView(input({ opacity: 0.2, setup: setup({ fixed: [{ hex: 0, face: 'XMinus' }] }) }));

        expect((overlays(view)[0].material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(0.6, 5);
        disposeMeshView(view);
      });
    });
  });
});
