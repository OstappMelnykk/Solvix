import { SolverMeshDto } from '../api/solver-api.service';
import { LOCAL_COORDS } from './mesh-editor-view';
import { buildFemMeshView } from './fem-mesh-view';
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
