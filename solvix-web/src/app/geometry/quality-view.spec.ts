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
  state: singleCubeState(), setup: setup({ divisions: [3, 1, 1] }), quality: quality([{ hex: 0, ex: 1 }]), metric: 'grade', look: { kind: 'solid' }, onlyBad: false, showFixed: false, showLoads: false, ...over
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

  it('has two looks only: filled and solid, or wholly transparent so that nothing but the edges shows', () => {
    const filled = buildQualityView(input());
    const wire = buildQualityView(input({ look: { kind: 'edges' } }));

    expect(material(faceMesh(filled)).transparent).toBeFalse();
    expect(material(faceMesh(filled)).opacity).toBe(1);
    expect(material(faceMesh(filled)).depthWrite).toBeTrue();
    expect(wire.pickables.length).toBe(1);                                   // one mesh: bad or not
    expect(material(faceMesh(wire)).opacity).toBe(0);                          // the faces draw only their edges
    expect(material(faceMesh(wire)).transparent).toBeTrue();
    expect(material(faceMesh(wire)).depthTest).toBeFalse();                  // so nothing hides anything
    expect(material(faceMesh(wire)).depthWrite).toBeFalse();
    disposeMeshView(filled);
    disposeMeshView(wire);
  });

  describe('see-through to an opacity', () => {
    const translucent = (opacity: number, over: Partial<QualityViewInput> = {}) => buildQualityView(input({ look: { kind: 'translucent', opacity }, ...over }));

    it('is one opacity for every face, blending with all the others (no depth test, so no order to go wrong)', () => {
      const see = translucent(0.4);

      expect(see.pickables.length).toBe(1);
      expect(material(faceMesh(see)).opacity).toBeCloseTo(0.4, 6);
      expect(material(faceMesh(see)).transparent).toBeTrue();
      expect(material(faceMesh(see)).depthTest).toBeFalse();
      expect(material(faceMesh(see)).depthWrite).toBeFalse();
      disposeMeshView(see);
    });

    it('never goes fully invisible, nor beyond solid', () => {
      const none = translucent(0);
      const over = translucent(3);

      expect(material(faceMesh(none)).opacity).toBeGreaterThanOrEqual(0.05);
      expect(material(faceMesh(over)).opacity).toBe(1);
      disposeMeshView(none);
      disposeMeshView(over);
    });

    it('also draws the faces around a bad element inside the body', () => {
      const solid = buildQualityView(input());
      const see = translucent(0.5);
      const none = translucent(0.5, { quality: quality([]) });

      expect(vertices(see)).toBeGreaterThan(vertices(solid));
      expect(vertices(see)).toBeGreaterThan(vertices(none));
      disposeMeshView(solid);
      disposeMeshView(see);
      disposeMeshView(none);
    });

    it('writes the depth of the outside invisibly, so the dots know what is in front of them', () => {
      const see = translucent(0.5);
      const depthOnly = see.root.children.filter(c => c instanceof THREE.Mesh && (c.material as THREE.Material).colorWrite === false);

      expect(depthOnly.length).toBe(1);
      disposeMeshView(see);
    });

    it('shows the cubes\' corners hidden by the body again (only those), weaker the more opaque the body is', () => {
      const solid = buildQualityView(input());
      const see = translucent(0.5);
      const count = (v: ReturnType<typeof buildQualityView>) => v.root.children.filter(c => c instanceof THREE.InstancedMesh).length;

      expect(count(see)).toBe(count(solid) + 1);
      const hidden = see.root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh).filter(m => !(m.material as THREE.MeshBasicMaterial).depthTest);
      expect(hidden.length).toBe(1);
      expect((hidden[0].material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(0);
      disposeMeshView(solid);
      disposeMeshView(see);
    });
  });

  it('in the edges-only look, also draws the faces around a bad element inside the body, so its edges show', () => {
    const filled = buildQualityView(input());
    const wire = buildQualityView(input({ look: { kind: 'edges' } }));
    const none = buildQualityView(input({ look: { kind: 'edges' }, quality: quality([]) }));

    expect(vertices(wire)).toBeGreaterThan(vertices(filled));
    expect(vertices(wire)).toBeGreaterThan(vertices(none));
    disposeMeshView(filled);
    disposeMeshView(wire);
    disposeMeshView(none);
  });

  it('does not fill the cut in the edges-only look', () => {
    const wire = buildQualityView(input({ look: { kind: 'edges' }, section: { axis: 0, at: 0.5, keep: 'above' } }));

    expect(wire.root.children.some(c => c.userData['sectionCap'])).toBeFalse();
    expect(wire.root.children.some(c => c.userData['sectionStructure'])).toBeTrue();
    disposeMeshView(wire);
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

  it('in the edges-only look, draws the cubes\' corners and midpoints over everything, and not the small elements\' nodes', () => {
    const filled = buildQualityView(input({ setup: setup({ divisions: [2, 2, 2] }), quality: quality([]) }));
    const wire = buildQualityView(input({ setup: setup({ divisions: [2, 2, 2] }), quality: quality([]), look: { kind: 'edges' } }));
    const spheres = (v: ReturnType<typeof buildQualityView>) => v.root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);

    expect(spheres(wire).length).toBe(2);
    expect(spheres(wire).every(m => !(m.material as THREE.MeshBasicMaterial).depthTest)).toBeTrue();
    expect(spheres(filled).every(m => (m.material as THREE.MeshBasicMaterial).depthTest)).toBeTrue();
    expect(wire.root.children.some(c => c instanceof THREE.Points)).toBeFalse();
    expect(filled.root.children.some(c => c instanceof THREE.Points)).toBeTrue();
    disposeMeshView(filled);
    disposeMeshView(wire);
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

describe('the sides of the Quality World view', () => {
  it('all turn outwards from their body, so a one-sided (see-through) body tints every side that faces the viewer', () => {
    const view = buildQualityView({
      state: singleCubeState(), setup: setup({ divisions: [2, 2, 2] }), quality: null, metric: 'grade', look: { kind: 'translucent', opacity: 0.5 },
      onlyBad: false, showFixed: false, showLoads: false
    });
    const mesh = view.pickables[0] as THREE.Mesh;
    const p = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex()!;
    const centre = new THREE.Vector3(0.5, 0.5, 0.5);
    let inward = 0;
    for (let i = 0; i < index.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(p, index.getX(i));
      const b = new THREE.Vector3().fromBufferAttribute(p, index.getX(i + 1));
      const c = new THREE.Vector3().fromBufferAttribute(p, index.getX(i + 2));
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      if (normal.dot(a.clone().sub(centre)) < -1e-9) inward++;
    }

    expect(inward).toBe(0);
    disposeMeshView(view);
  });
});
