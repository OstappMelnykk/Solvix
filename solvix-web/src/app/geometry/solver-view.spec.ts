import * as THREE from 'three';
import { SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { MeshPick, disposeMeshView } from './mesh-editor-view';
import { SolverViewInput, buildSolverView, fieldRange, fieldValues, materialColor, rampColor } from './solver-view';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

const setup = (over: Partial<SolverSetupDto> = {}): SolverSetupDto => ({
  version: 0,
  materials: [],
  defaultMaterial: 'steel',
  hexMaterials: {},
  fixed: [],
  loads: [],
  ...over
});

const resultFor = (nodeIds: number[], values: (id: number) => { u?: [number, number, number]; vm?: number }): SolverResultDto => ({
  ticket: 1,
  nodeIds,
  ux: nodeIds.map(id => values(id).u?.[0] ?? 0),
  uy: nodeIds.map(id => values(id).u?.[1] ?? 0),
  uz: nodeIds.map(id => values(id).u?.[2] ?? 0),
  vonMises: nodeIds.map(id => values(id).vm ?? 0),
  maxDisplacement: 0,
  maxVonMises: 0,
  elapsedSeconds: 0
});

const input = (over: Partial<SolverViewInput> = {}): SolverViewInput => ({
  state: linkedPairState(),
  setup: setup(),
  result: null,
  field: 'vonMises',
  deformationScale: 1,
  selectedHexes: [],
  selectedFace: null,
  ...over
});

const meshes = (root: THREE.Object3D) => root.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
const colorsOf = (mesh: THREE.Mesh) => Array.from(mesh.geometry.getAttribute('color').array);
const positionsOf = (mesh: THREE.Mesh) => Array.from(mesh.geometry.getAttribute('position').array);

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
    const result = resultFor([1, 2, 3], id => ({ u: [id, 0, 0], vm: id * 10 }));

    it('von Mises values come straight from the result, displacement as the length of the vector', () => {
      expect(fieldValues(result, 'vonMises')).toEqual([10, 20, 30]);
      expect(fieldValues(result, 'displacement')).toEqual([1, 2, 3]);
      expect(fieldValues(result, 'none')).toBeNull();
    });

    it('the range of a field, and of nothing', () => {
      expect(fieldRange([3, 1, 2])).toEqual({ min: 1, max: 3 });
      expect(fieldRange([])).toEqual({ min: 0, max: 0 });
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

    it('draws the curved edges of every cube as one set of lines', () => {
      const view = buildSolverView(input());
      const lines = view.root.children.filter(c => c instanceof THREE.LineSegments) as THREE.LineSegments[];

      expect(lines.length).toBe(1);
      expect(lines[0].geometry.getAttribute('position').count).toBe(2 * 12 * 10 * 2);   // 2 cubes x 12 edges x 10 segments x 2 ends
      disposeMeshView(view);
    });

    it('colours a cube by its material while there is no result', () => {
      const view = buildSolverView(input({ setup: setup({ hexMaterials: { '1': 'rubber' } }) }));
      const faceOf = (hex: number) => view.pickables.find(p => (p.userData['pick'] as { hex: number }).hex === hex) as THREE.Mesh;

      const steel = new THREE.Color(colorsOf(faceOf(0))[0], colorsOf(faceOf(0))[1], colorsOf(faceOf(0))[2]);
      const rubber = new THREE.Color(colorsOf(faceOf(1))[0], colorsOf(faceOf(1))[1], colorsOf(faceOf(1))[2]);
      expect(steel.r).toBeCloseTo(materialColor('steel').r, 5);
      expect(rubber.g).toBeCloseTo(materialColor('rubber').g, 5);
      expect(steel.getHex()).not.toBe(rubber.getHex());
      disposeMeshView(view);
    });

    it('overlays clamped faces in red and pressed faces in blue, on the faces that carry them only', () => {
      const plain = buildSolverView(input());
      const marked = buildSolverView(input({ setup: setup({ fixed: [{ hex: 0, face: 'XMinus' }], loads: [{ hex: 1, face: 'XPlus', pressure: 1e6 }] }) }));
      const overlays = (v: ReturnType<typeof buildSolverView>) => meshes(v.root).filter(m => (m.material as THREE.MeshBasicMaterial).transparent);

      expect(overlays(plain).length).toBe(0);
      const found = overlays(marked);
      expect(found.length).toBe(2);
      const hexes = found.map(m => new THREE.Color(colorsOf(m)[0], colorsOf(m)[1], colorsOf(m)[2]).getHex());
      expect(hexes).toContain(0xe05252);
      expect(hexes).toContain(0x39a6f2);
      disposeMeshView(plain);
      disposeMeshView(marked);
    });

    it('does not overlay a clamped face that is inside the body', () => {
      const view = buildSolverView(input({ setup: setup({ fixed: [{ hex: 0, face: 'XPlus' }] }) }));

      expect(meshes(view.root).filter(m => (m.material as THREE.MeshBasicMaterial).transparent).length).toBe(0);
      disposeMeshView(view);
    });

    it('colours by the field after a solve: the highest value is red, the lowest blue, and it varies across a face', () => {
      const state = singleCubeState();
      const result = resultFor(state.nodes.map(n => n.id), id => ({ vm: state.nodes[id].z * 1e6 }));   // stress grows with height

      const view = buildSolverView(input({ state, result, field: 'vonMises' }));
      const top = view.pickables.find(p => (p.userData['pick'] as { face: string }).face === 'ZPlus') as THREE.Mesh;
      const bottom = view.pickables.find(p => (p.userData['pick'] as { face: string }).face === 'ZMinus') as THREE.Mesh;

      expect(new THREE.Color(colorsOf(top)[0], colorsOf(top)[1], colorsOf(top)[2]).getHex()).toBe(0xe4572e);
      expect(new THREE.Color(colorsOf(bottom)[0], colorsOf(bottom)[1], colorsOf(bottom)[2]).getHex()).toBe(0x2b3cc4);
      const side = view.pickables.find(p => (p.userData['pick'] as { face: string }).face === 'XPlus') as THREE.Mesh;
      const sideColors = colorsOf(side);
      expect(new Set(sideColors.map(c => c.toFixed(3))).size).toBeGreaterThan(3);      // a gradient, not one colour
      disposeMeshView(view);
    });

    it('"materials" as the field keeps the material colours even with a result', () => {
      const state = singleCubeState();
      const result = resultFor(state.nodes.map(n => n.id), () => ({ vm: 5e6 }));

      const view = buildSolverView(input({ state, result, field: 'none' }));
      const face = view.pickables[0] as THREE.Mesh;

      expect(colorsOf(face)[0]).toBeCloseTo(materialColor('steel').r, 5);
      disposeMeshView(view);
    });

    it('draws the body deformed by the displacement times the scale, and not at all with scale 0 or without a result', () => {
      const state = singleCubeState();
      const result = resultFor(state.nodes.map(n => n.id), () => ({ u: [0, 0, 0.1] }));
      const topZ = (v: ReturnType<typeof buildSolverView>) => {
        const face = v.pickables.find(p => (p.userData['pick'] as { face: string }).face === 'ZPlus') as THREE.Mesh;
        return positionsOf(face)[2];
      };

      const shifted = buildSolverView(input({ state, result, deformationScale: 5 }));
      const still = buildSolverView(input({ state, result, deformationScale: 0 }));
      const none = buildSolverView(input({ state, result: null }));

      expect(topZ(shifted)).toBeCloseTo(1.5, 5);
      expect(topZ(still)).toBeCloseTo(1, 5);
      expect(topZ(none)).toBeCloseTo(1, 5);
      [shifted, still, none].forEach(disposeMeshView);
    });

    it('tints the picked cubes and marks the picked face', () => {
      const plain = buildSolverView(input());
      const picked = buildSolverView(input({ selectedHexes: [0], selectedFace: { hex: 1, face: 'XPlus' } }));
      const firstFace = (v: ReturnType<typeof buildSolverView>, hex: number) => v.pickables.find(p => (p.userData['pick'] as { hex: number }).hex === hex) as THREE.Mesh;

      expect(colorsOf(firstFace(picked, 0))[0]).not.toBeCloseTo(colorsOf(firstFace(plain, 0))[0], 3);
      expect(colorsOf(firstFace(picked, 1))[0]).toBeCloseTo(colorsOf(firstFace(plain, 1))[0], 5);
      const marks = meshes(picked.root).filter(m => (m.material as THREE.MeshBasicMaterial).transparent);
      expect(marks.length).toBe(1);
      expect(new THREE.Color(colorsOf(marks[0])[0], colorsOf(marks[0])[1], colorsOf(marks[0])[2]).getHex()).toBe(0xffe14d);
      disposeMeshView(plain);
      disposeMeshView(picked);
    });

    it('a field that is zero everywhere is one colour, not NaN', () => {
      const state = singleCubeState();
      const result = resultFor(state.nodes.map(n => n.id), () => ({ vm: 0 }));

      const view = buildSolverView(input({ state, result }));

      expect(colorsOf(view.pickables[0] as THREE.Mesh).every(Number.isFinite)).toBeTrue();
      disposeMeshView(view);
    });
  });
});
