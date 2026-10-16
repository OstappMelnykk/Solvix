import * as THREE from 'three';
import { SolverQualityDto, SolverSetupDto } from '../api/solver-api.service';
import { PickedFace, disposeMeshView } from './mesh-editor-view';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';
import { QualityViewInput, buildQualityView } from './quality-view';

const setup = (over: Partial<SolverSetupDto> = {}): SolverSetupDto => ({
  version: 0, divisions: [1, 1, 1], materials: [], defaultMaterial: 'steel', hexMaterials: {}, elementMaterials: [], fixed: [], loads: [], ...over
});

// the elements named are flagged invalid; any other is excellent (the server does not list it)
const quality = (bad: { hex: number; ex: number; ey?: number; ez?: number }[]): SolverQualityDto => ({
  id: 'solvix', name: 'Solvix', source: '', note: '', elements: 0,
  grades: { excellent: 0, good: 0, acceptable: 0, poor: 0, invalid: 0 }, worst: {}, limits: [],
  flagged: bad.map(b => ({ hex: b.hex, ex: b.ex, ey: b.ey ?? 0, ez: b.ez ?? 0, grade: 'invalid' as const, values: { scaledJacobian: 0.1 } }))
});

const input = (over: Partial<QualityViewInput> = {}): QualityViewInput => ({
  state: singleCubeState(), setup: setup({ divisions: [3, 1, 1] }), quality: quality([{ hex: 0, ex: 1 }]), metric: 'grade', opacity: 1, onlyBad: false, showFixed: false, showLoads: false, ...over
});

const faceMesh = (view: ReturnType<typeof buildQualityView>) => view.pickables[0] as THREE.Mesh;
const vertices = (view: ReturnType<typeof buildQualityView>) => faceMesh(view).geometry.getAttribute('position').count;
const colourAt = (mesh: THREE.Mesh, i: number) => new THREE.Color(mesh.geometry.getAttribute('color').getX(i), mesh.geometry.getAttribute('color').getY(i), mesh.geometry.getAttribute('color').getZ(i));
const material = (mesh: THREE.Mesh) => mesh.material as THREE.MeshLambertMaterial;

describe('the Quality World view', () => {
  it('colours each small element by its own grade: the bad one red, the others green', () => {
    const view = buildQualityView(input());
    const mesh = faceMesh(view);
    const kinds = new Set<string>();
    for (let i = 0; i < mesh.geometry.getAttribute('color').count; i++) {
      const c = colourAt(mesh, i);
      kinds.add(c.r > c.g * 2 ? 'red' : c.g > c.r ? 'green' : 'other');
    }

    expect(kinds.has('red')).toBeTrue();
    expect(kinds.has('green')).toBeTrue();
    expect(kinds.has('other')).toBeFalse();
    disposeMeshView(view);
  });

  it('is one tone of the body when there is no result yet', () => {
    const view = buildQualityView(input({ quality: null }));
    const c = colourAt(faceMesh(view), 0);

    expect(c.b).toBeGreaterThan(c.r);
    disposeMeshView(view);
  });

  it('draws a lit matt body whose faces draw their own edges (a position inside every small face)', () => {
    const view = buildQualityView(input());
    const mesh = faceMesh(view);
    const uv = mesh.geometry.getAttribute('faceUv');

    expect(material(mesh) instanceof THREE.MeshLambertMaterial).toBeTrue();
    expect(uv.count).toBe(mesh.geometry.getAttribute('position').count);
    expect(Array.from({ length: uv.count * 2 }, (_, i) => Math.abs(uv.array[i])).every(v => v <= 1 + 1e-9)).toBeTrue();
    expect(mesh.geometry.getAttribute('normal')).toBeDefined();
    expect(material(mesh).onBeforeCompile).toBeDefined();
    disposeMeshView(view);
  });

  it('is solid at 100%, and below it one opacity for every face that blends with the others (no depth test, so no order to go wrong)', () => {
    const solid = buildQualityView(input());
    const see = buildQualityView(input({ opacity: 0.4 }));

    expect(material(faceMesh(solid)).transparent).toBeFalse();
    expect(material(faceMesh(solid)).depthWrite).toBeTrue();
    expect(see.pickables.length).toBe(1);                                    // one mesh: bad or not, one tone
    expect(material(faceMesh(see)).opacity).toBeCloseTo(0.4, 6);
    expect(material(faceMesh(see)).transparent).toBeTrue();
    expect(material(faceMesh(see)).depthTest).toBeFalse();
    expect(material(faceMesh(see)).depthWrite).toBeFalse();
    disposeMeshView(solid);
    disposeMeshView(see);
  });

  it('never goes fully invisible', () => {
    const view = buildQualityView(input({ opacity: 0 }));

    expect(material(faceMesh(view)).opacity).toBeGreaterThanOrEqual(0.05);
    disposeMeshView(view);
  });

  it('with the body see-through, also draws the faces around a bad element inside it', () => {
    const solid = buildQualityView(input());
    const see = buildQualityView(input({ opacity: 0.5 }));
    const none = buildQualityView(input({ opacity: 0.5, quality: quality([]) }));

    expect(vertices(see)).toBeGreaterThan(vertices(solid));
    expect(vertices(see)).toBeGreaterThan(vertices(none));
    disposeMeshView(solid);
    disposeMeshView(see);
    disposeMeshView(none);
  });

  it('writes the depth of the outside invisibly when the body is see-through, so the dots and lines know what is in front of them', () => {
    const see = buildQualityView(input({ opacity: 0.5 }));
    const depthOnly = see.root.children.filter(c => c instanceof THREE.Mesh && (c.material as THREE.Material).colorWrite === false);

    expect(depthOnly.length).toBe(1);
    disposeMeshView(see);
  });

  it('a click on a triangle resolves to the small face: its cube, side, cell and element', () => {
    const view = buildQualityView(input());
    const mesh = faceMesh(view);
    const resolve = mesh.userData['resolvePick'] as (t: number) => PickedFace;
    const first = resolve(0);

    expect(first.kind).toBe('face');
    expect(first.hex).toBe(0);
    expect(first.element).toBeDefined();
    expect(first.inner).toBeFalse();
    disposeMeshView(view);
  });

  it('can draw only the bad elements', () => {
    const all = buildQualityView(input());
    const one = buildQualityView(input({ onlyBad: true }));

    expect(vertices(one)).toBeGreaterThan(0);
    expect(vertices(one)).toBeLessThan(vertices(all));
    disposeMeshView(all);
    disposeMeshView(one);
  });

  it('draws the nodes: the 8 corners and 12 midpoints of a cube as dots, and the nodes of the small elements between them as small ones', () => {
    const view = buildQualityView(input({ setup: setup({ divisions: [2, 2, 2] }), quality: quality([]) }));
    const spheres = view.root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
    const small = view.root.children.filter((c): c is THREE.Points => c instanceof THREE.Points);

    expect(spheres.map(s => s.count).sort((a, b) => a - b)).toEqual([8, 12]);
    expect(small.length).toBe(1);
    expect(small[0].geometry.getAttribute('position').count).toBeGreaterThan(0);
    disposeMeshView(view);
  });

  it('shows the dots hidden by the body again, weaker the more opaque the body is, and none at all for a solid one', () => {
    const solid = buildQualityView(input());
    const see = buildQualityView(input({ opacity: 0.5 }));
    const count = (v: ReturnType<typeof buildQualityView>) => v.root.children.filter(c => c instanceof THREE.InstancedMesh).length;

    expect(count(see)).toBe(2 * count(solid));
    const hidden = see.root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh).filter(m => !(m.material as THREE.MeshBasicMaterial).depthTest);
    expect(hidden.length).toBe(count(solid));
    expect((hidden[0].material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(0);
    disposeMeshView(solid);
    disposeMeshView(see);
  });

  describe('the clamps and the loads', () => {
    const marked = (over: Partial<QualityViewInput>) =>
      buildQualityView(input({
        state: singleCubeState(), setup: setup({ fixed: [{ hex: 0, face: 'XMinus', p: 0, q: 0 }], loads: [{ hex: 0, face: 'XPlus', p: 0, q: 0, pressure: -1e6 }] }), quality: quality([]), ...over
      }));
    const coats = (view: ReturnType<typeof buildQualityView>) =>
      view.root.children.filter(c => c instanceof THREE.Mesh && !(c instanceof THREE.InstancedMesh) && !view.pickables.includes(c) && c.material instanceof THREE.MeshBasicMaterial && c.material.transparent && c.material.colorWrite);

    it('lays a blue coat over a clamped face and a green one over a pressed face, each switched on by itself', () => {
      const both = marked({ showFixed: true, showLoads: true });
      const fixed = marked({ showFixed: true });
      const none = marked({});

      expect(coats(both).length).toBe(2);
      expect(coats(fixed).length).toBe(1);
      expect(coats(none).length).toBe(0);
      disposeMeshView(both);
      disposeMeshView(fixed);
      disposeMeshView(none);
    });

    it('writes the pressure on the pressed face', () => {
      const view = marked({ showLoads: true });

      expect(view.root.children.some(c => c.userData['pressureLabel'])).toBeTrue();
      disposeMeshView(view);
    });
  });

  describe('a section', () => {
    const cut = (keep: 'above' | 'below', at = 1.5) => ({ axis: 0 as const, at, keep });
    const row = () => linkedPairState();
    const section = (keep: 'above' | 'below', over: Partial<QualityViewInput> = {}) =>
      buildQualityView(input({ state: row(), setup: setup({ divisions: [2, 1, 1] }), quality: quality([]), section: cut(keep, 0.5), ...over }));

    it('cuts with a clipping plane of the GPU on every material of the view, keeping the side asked for', () => {
      for (const keep of ['above', 'below'] as const) {
        const view = section(keep);
        const planes = (faceMesh(view).material as THREE.Material).clippingPlanes!;

        expect(planes.length).toBe(1);
        const sign = keep === 'above' ? 1 : -1;
        expect(planes[0].distanceToPoint(new THREE.Vector3(0.5 + sign * 0.3, 0, 0))).toBeGreaterThan(0);
        expect(planes[0].distanceToPoint(new THREE.Vector3(0.5 - sign * 0.3, 0, 0))).toBeLessThan(0);
        for (const c of view.root.children.filter(o => o instanceof THREE.InstancedMesh)) expect(((c as THREE.Mesh).material as THREE.Material).clippingPlanes!.length).toBe(1);
        disposeMeshView(view);
      }
    });

    it('does not cut without a section', () => {
      const view = buildQualityView(input());

      expect((faceMesh(view).material as THREE.Material).clippingPlanes).toEqual([]);
      disposeMeshView(view);
    });

    it('cannot be clicked on where it is cut away, though the ray passes through it', () => {
      const view = section('above');
      const raycaster = new THREE.Raycaster(new THREE.Vector3(-2, 0.5, 0.5), new THREE.Vector3(1, 0, 0));
      const hits = raycaster.intersectObjects(view.pickables, false);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every(h => h.point.x > 0.5 - 1e-6)).toBeTrue();
      disposeMeshView(view);
    });

    it('draws the sheet of the plane, not pickable, and the outline of the cut', () => {
      const view = section('below', { section: cut('below', 0.25) });       // through the middle of an element: the plane on the faces of elements has no outline of its own

      expect(view.root.children.some(c => c.userData['sectionPlane'])).toBeTrue();
      expect(view.pickables.some(p => p.userData['sectionPlane'])).toBeFalse();
      expect(view.root.children.some(c => c.userData['sectionStructure'])).toBeTrue();
      disposeMeshView(view);
    });

    it('fills the cut with a cap in the colour of each element the plane runs through, lit like the faces', () => {
      const view = buildQualityView(input({ state: singleCubeState(), setup: setup({ divisions: [3, 1, 1] }), quality: quality([{ hex: 0, ex: 1 }]), section: cut('above', 0.5) }));
      const cap = view.root.children.find(c => c.userData['sectionCap']) as THREE.Mesh;
      const colour = cap.geometry.getAttribute('color');

      expect(cap).toBeDefined();
      expect(cap.material instanceof THREE.MeshLambertMaterial).toBeTrue();
      expect(cap.geometry.getAttribute('normal')).toBeDefined();
      expect(colour.getX(0)).toBeGreaterThan(colour.getY(0) * 2);                    // the middle element, cut at 0.5, is the invalid one: red
      disposeMeshView(view);
    });

    it('draws no labels of the pressures on a cut body', () => {
      const view = buildQualityView(input({
        state: singleCubeState(), setup: setup({ loads: [{ hex: 0, face: 'XPlus', p: 0, q: 0, pressure: -1e6 }] }), quality: quality([]), showLoads: true, section: cut('above', 0.5)
      }));

      expect(view.root.children.some(c => c.userData['pressureLabel'])).toBeFalse();
      disposeMeshView(view);
    });
  });

  it('puts a highlight into the view and takes it out again', () => {
    const view = buildQualityView(input());
    const group = new THREE.Group();
    const before = view.root.children.length;

    view.setHighlight!(group);
    expect(view.root.children.length).toBe(before + 1);
    view.setHighlight!(null);
    expect(view.root.children.length).toBe(before);
    disposeMeshView(view);
  });
});
