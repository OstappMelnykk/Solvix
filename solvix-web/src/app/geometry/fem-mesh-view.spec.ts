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

describe('buildFemMeshView with the edges inside', () => {
  // two elements stacked along z: the face between them is inside the body, the other ten are on the surface
  const stacked = (): SolverMeshDto => {
    const connectivity: number[] = [];
    for (let e = 0; e < 2; e++) {
      const slots = new Array(20).fill(0);
      for (let i = 0; i < 4; i++) { slots[i] = 4 * e + i; slots[4 + i] = 4 * (e + 1) + i; }
      connectivity.push(...slots);
    }
    return { ...oneElement(), elementCount: 2, hexIds: [7, 7], keys: ['a', 'b'], materials: ['', ''], connectivity, positions: new Array(60).fill(0), surfaceFaces: [0, 0] };
  };
  const segments = (view: ReturnType<typeof buildFemMeshView>) => (view.root.children.find(o => o.userData['edges']) as THREE.LineSegments).geometry.getAttribute('position').count / 2;

  it('draws the edges of the face between two elements once, and none of it without the option', () => {
    const plain = segments(buildFemMeshView(input(stacked())));
    const inner = segments(buildFemMeshView(input(stacked(), { innerEdges: true })));
    // 4 sides of a face, 6 segments each; the surface face alone, then 11 faces (12 minus the shared one counted once)
    expect(plain).toBe(1 * 4 * 6);
    expect(inner).toBe(11 * 4 * 6);
  });
});

describe('buildFemMeshView edges seen through a body', () => {
  it('draws the edges a second time over everything when asked, and once otherwise', () => {
    const count = (view: ReturnType<typeof buildFemMeshView>) => view.root.children.filter(o => o.userData['edges']).length;
    expect(count(buildFemMeshView(input(oneElement())))).toBe(1);
    const through = buildFemMeshView(input(oneElement(), { ghostEdges: 0.6 }));
    expect(count(through)).toBe(2);
    const twin = through.root.children.filter(o => o.userData['edges'])[1] as THREE.LineSegments;
    expect((twin.material as THREE.LineBasicMaterial).depthTest).toBeFalse();
  });
});

describe('buildFemMeshView with wide edges', () => {
  it('draws the edges as wide lines of the width asked for, and the plain thin ones for a result', () => {
    const wide = buildFemMeshView(input(oneElement(), { edgeWidth: 3 }));
    const edges = wide.root.children.find(o => o.userData['edges']) as unknown as { material: { linewidth: number } };
    expect(edges.material.linewidth).toBe(3);

    const result = { ticket: 1, divisions: [1, 1, 1], positions: LOCAL_COORDS.flatMap(c => [...c]), hexIds: [7], gridNodes: [], ux: LOCAL_COORDS.map(() => 0), uy: LOCAL_COORDS.map(() => 0), uz: LOCAL_COORDS.map(() => 0), vonMises: LOCAL_COORDS.map(() => 1), maxDisplacement: 0, maxVonMises: 1, elapsedSeconds: 0 };
    const thin = buildFemMeshView(input(oneElement(), { edgeWidth: 3, result, field: 'vonMises' }));
    expect(thin.root.children.find(o => o.userData['edges'])).toBeInstanceOf(THREE.LineSegments);
  });

  it('pushes the faces back a little so the edges lying on them are not hidden', () => {
    const body = buildFemMeshView(input(oneElement())).pickables[0] as THREE.Mesh;
    expect((body.material as THREE.MeshBasicMaterial).polygonOffset).toBeTrue();
  });
});

describe('buildFemMeshView with every face', () => {
  // two elements stacked along z (the face between them is inside), only the first on the surface of the body except for its top
  const stacked = (): SolverMeshDto => {
    const connectivity: number[] = [];
    for (let e = 0; e < 2; e++) {
      const slots = new Array(20).fill(0);
      for (let i = 0; i < 4; i++) { slots[i] = 4 * e + i; slots[4 + i] = 4 * (e + 1) + i; }
      connectivity.push(...slots);
    }
    return { ...oneElement(), elementCount: 2, hexIds: [7, 7], keys: ['a', 'b'], materials: ['', ''], connectivity, positions: new Array(60).fill(0), surfaceFaces: [0, 0, 1, 1] };
  };
  const faceCount = (view: ReturnType<typeof buildFemMeshView>) => (view.pickables[0] as THREE.Mesh).geometry.getAttribute('position').count / 16;
  const resolve = (view: ReturnType<typeof buildFemMeshView>, face: number) => (view.pickables[0] as THREE.Mesh).userData['resolvePick'](face * 18) as { inner: boolean; elementKey: string };

  it('draws only the surface faces, or all of them once when asked, the ones inside marked as inside', () => {
    expect(faceCount(buildFemMeshView(input(stacked())))).toBe(2);
    const all = buildFemMeshView(input(stacked(), { allFaces: true }));
    expect(faceCount(all)).toBe(11);
    expect(Array.from({ length: 11 }, (_, i) => resolve(all, i).inner).filter(Boolean).length).toBe(9);
  });

  it('an element shown alone is shown whole, and a face two shown elements share is drawn once', () => {
    const alone = buildFemMeshView(input(stacked(), { allFaces: true, skipElement: (e: number) => e === 1 }));
    expect(faceCount(alone)).toBe(6);
    expect(Array.from({ length: 6 }, (_, i) => resolve(alone, i).elementKey)).toEqual(Array(6).fill('a'));
  });

  it('the face between two elements takes its colour from the one of the higher rank', () => {
    const view = buildFemMeshView(input(stacked(), { allFaces: true, elementColor: (e: number) => (e === 1 ? 0xff0000 : 0x00ff00), rank: (e: number) => e }));
    const colors = (view.pickables[0] as THREE.Mesh).geometry.getAttribute('color');
    const shared = Array.from({ length: 11 }, (_, i) => i).find(i => resolve(view, i).elementKey === 'b' && resolve(view, i).inner)!;
    expect(colors.getX(shared * 16)).toBeGreaterThan(0.3);
    expect(colors.getY(shared * 16)).toBeLessThan(0.1);
  });
});
