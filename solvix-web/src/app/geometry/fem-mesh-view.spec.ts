import { SolverMeshDto } from '../api/solver-api.service';
import { LOCAL_COORDS } from './mesh-editor-view';
import { buildFemHighlight, buildFemMeshView } from './fem-mesh-view';
import { femIndex } from './fem-targets';
import * as THREE from 'three';

// one cube [-1,1]^3 as a single element, all its six faces on the surface
function oneElement(extra: Partial<SolverMeshDto> = {}): SolverMeshDto {
  return {
    rule: 'local', nodeCount: 20, elementCount: 1,
    positions: LOCAL_COORDS.flatMap(c => [...c]),
    connectivity: Array.from({ length: 20 }, (_, i) => i),
    hexIds: [7], keys: ['7|1|k'], materials: [''],
    surfaceFaces: [0, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5],
    fixedFaces: [], loadedFaces: [], pressures: [],
    ...extra
  };
}

const input = (mesh: SolverMeshDto, more = {}) => ({ mesh, defaultMaterial: 'steel', bodyColor: 0xe4e7eb, opacity: 1, ...more });

describe('buildFemMeshView', () => {
  it('draws every surface face and names the face under a click by the element\'s key', () => {
    const view = buildFemMeshView(input(oneElement()));
    const body = view.pickables[0] as THREE.Mesh;
    const resolve = body.userData['resolvePick'] as (t: number) => { elementKey: string; localFace: number; hex: number } | null;

    expect(resolve(0)).toEqual(jasmine.objectContaining({ elementKey: '7|1|k', localFace: 0, hex: 7 }));
    expect(resolve(18 * 5)?.localFace).toBe(5);
    expect(resolve(18 * 6)).toBeNull();
  });

  it('puts each face where the element is', () => {
    const view = buildFemMeshView(input(oneElement({ surfaceFaces: [0, 5] })));   // XPlus
    const positions = (view.pickables[0] as THREE.Mesh).geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) expect(positions.getX(i)).toBeCloseTo(1, 6);
  });

  it('leaves out the elements of a hidden material', () => {
    const view = buildFemMeshView(input(oneElement({ materials: ['rubber'] }), { hiddenMaterials: new Set(['rubber']) }));
    expect((view.pickables[0] as THREE.Mesh).geometry.getAttribute('position').count).toBe(0);
  });

  it('adds a coat for the clamped and for the pressed faces, and none when they are switched off', () => {
    const mesh = oneElement({ fixedFaces: [0, 4], loadedFaces: [0, 5], pressures: [-1e6] });
    expect(buildFemMeshView(input(mesh)).root.children.length).toBe(4);   // body, two coats, edges
    expect(buildFemMeshView(input(mesh, { showFixed: false, showLoads: false })).root.children.length).toBe(2);
  });
});

describe('buildFemHighlight', () => {
  const mesh = oneElement();
  const index = femIndex(mesh);

  it('draws a coat on the faces and the edges of the elements', () => {
    const group = buildFemHighlight(mesh, index, { faces: [{ key: '7|1|k', face: 5 }], elements: ['7|1|k'], pointed: null });
    expect(group.children.length).toBe(2);
    const coat = group.children[0] as THREE.Mesh;
    expect(coat.geometry.getIndex()!.count).toBe(3 * 3 * 6);
    // every triangle refers to vertices that exist
    expect(Math.max(...Array.from(coat.geometry.getIndex()!.array))).toBeLessThan(coat.geometry.getAttribute('position').count);
  });

  it('puts the second face\'s triangles after the first\'s vertices', () => {
    const group = buildFemHighlight(mesh, index, { faces: [{ key: '7|1|k', face: 0 }, { key: '7|1|k', face: 1 }], elements: [], pointed: null });
    const coat = group.children[0] as THREE.Mesh;
    expect(coat.geometry.getAttribute('position').count).toBe(32);
    expect(Math.max(...Array.from(coat.geometry.getIndex()!.array))).toBe(31);
  });

  it('ignores a key the mesh does not have', () => {
    expect(buildFemHighlight(mesh, index, { faces: [{ key: 'nope', face: 0 }], elements: ['nope'], pointed: null }).children.length).toBe(0);
  });
});

describe('buildFemMeshView with a result', () => {
  // the cube stretched: every node moves 0.5 along x
  const result = (more = {}) => ({
    ticket: 1, divisions: [1, 1, 1], positions: LOCAL_COORDS.flatMap(c => [...c]), hexIds: [7], gridNodes: [],
    ux: LOCAL_COORDS.map(() => 0.5), uy: LOCAL_COORDS.map(() => 0), uz: LOCAL_COORDS.map(() => 0),
    vonMises: LOCAL_COORDS.map((_, i) => i), maxDisplacement: 0.5, maxVonMises: 19, elapsedSeconds: 0, ...more
  });
  const solved = (more = {}) => buildFemMeshView(input(oneElement({ surfaceFaces: [0, 5] }), { result: result(), field: 'vonMises', deformationScale: 0, ...more }));
  const xs = (view: ReturnType<typeof solved>) => {
    const position = (view.pickables[0] as THREE.Mesh).geometry.getAttribute('position');
    return Array.from({ length: position.count }, (_, i) => position.getX(i));
  };

  it('draws the body deformed by the scale asked for, and moves it in place', () => {
    const view = solved();
    expect(xs(view).every(x => Math.abs(x - 1) < 1e-6)).toBeTrue();
    view.setDeformation!(2);
    expect(xs(view).every(x => Math.abs(x - 2) < 1e-6)).toBeTrue();
  });

  it('colours the surface by the field, hotter where the value is larger', () => {
    const view = solved();
    const color = (view.pickables[0] as THREE.Mesh).geometry.getAttribute('color');
    const reds = Array.from({ length: color.count }, (_, i) => color.getX(i));
    expect(new Set(reds.map(r => r.toFixed(3))).size).toBeGreaterThan(1);
    expect(view.setColorRange).toBeDefined();
  });

  it('draws the arrows of the displacements, and ignores a result of another mesh', () => {
    expect(solved().root.children.some(o => o.userData['vectors'])).toBeTrue();
    const other = buildFemMeshView(input(oneElement({ surfaceFaces: [0, 5] }), { result: result({ positions: [0, 0, 0] }), field: 'vonMises' }));
    expect(other.setDeformation).toBeUndefined();
  });
});

describe('buildFemMeshView for the Quality World', () => {
  const mesh = oneElement({ surfaceFaces: [0, 5] });

  it('paints an element in the colour it is given, and leaves out the ones to skip', () => {
    const view = buildFemMeshView(input(mesh, { elementColor: () => 0xff0000 }));
    const color = (view.pickables[0] as THREE.Mesh).geometry.getAttribute('color');
    expect(color.getX(0)).toBeGreaterThan(color.getY(0) * 3);
    const none = buildFemMeshView(input(mesh, { skipElement: () => true }));
    expect((none.pickables[0] as THREE.Mesh).geometry.getAttribute('position').count).toBe(0);
  });

  it('with only the edges the faces stay to be pointed at but cannot be seen, and the edges take the element\'s colour', () => {
    const view = buildFemMeshView(input(mesh, { look: 'edges', elementColor: () => 0xff0000 }));
    const body = view.pickables[0] as THREE.Mesh;
    expect((body.material as THREE.MeshBasicMaterial).opacity).toBe(0);
    const edges = view.root.children.find(o => o.userData['edges']) as THREE.LineSegments;
    const color = edges.geometry.getAttribute('color');
    expect(color.getX(0)).toBe(1);
    expect(color.getY(0)).toBe(0);
  });
});
