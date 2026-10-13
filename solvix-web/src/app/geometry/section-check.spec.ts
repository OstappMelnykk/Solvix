import * as THREE from 'three';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import { SolverSetupDto } from '../api/solver-api.service';
import { LOCAL_COORDS, disposeMeshView } from './mesh-editor-view';
import { SectionCut, buildSolverView } from './solver-view';
import { ALL_FACES, cubeHex, cubeNodes } from './mesh-state.fixture.spec';

// A row of n unit cubes along x, sharing the nodes of the faces between them.
function row(n: number): MeshStateDto {
  const nodes: ReturnType<typeof cubeNodes> = [];
  const hexes: ReturnType<typeof cubeHex>[] = [];
  const byKey = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const local = cubeNodes(0, [i, 0, 0]);
    const ids = local.map(node => {
      const key = `${node.idealX},${node.idealY},${node.idealZ}`;
      if (!byKey.has(key)) {
        byKey.set(key, nodes.length);
        nodes.push({ ...node, id: nodes.length });
      }
      return byKey.get(key)!;
    });
    hexes.push({ ...cubeHex(i, 0, [i, 0, 0]), nodeIds: ids });
  }
  const faces = hexes.flatMap(h => ALL_FACES.map(face => {
    const axis = face.charCodeAt(0) - 88, sign = face.endsWith('Plus') ? 1 : -1;
    const linked = axis === 0 && hexes[h.id + sign] !== undefined;
    return { hex: h.id, face, status: linked ? 'Linked' : 'Free', otherHex: linked ? h.id + sign : null, otherFace: null, coincident: null, gap: null };
  }));
  return { version: 1, canUndo: false, canRedo: false, hexes, nodes, links: [], faces, invalidHexes: [] } as unknown as MeshStateDto;
}

const setupOf = (divisions: [number, number, number]): SolverSetupDto => ({
  version: 0, divisions, materials: [], defaultMaterial: 'steel', hexMaterials: {}, elementMaterials: [], fixed: [], loads: []
});

// the area of the cap of a cut: the sum of its triangles
function capArea(cap: THREE.Mesh): { area: number; negative: number } {
  const p = cap.geometry.getAttribute('position');
  let area = 0, negative = 0;
  for (let i = 0; i + 2 < p.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, i), b = new THREE.Vector3().fromBufferAttribute(p, i + 1), c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
    area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    if (b.clone().sub(a).cross(c.clone().sub(a)).length() < 1e-12) negative++;
  }
  return { area, negative };
}

describe('the cap of a section', () => {
  // The cut of a row of unit cubes by a plane across x is always the 1 x 1 square of the cross-section, whatever the plane and
  // the divisions: the cap must have exactly that area (no hole, no overlap), also when the plane lies on the faces of elements.
  for (const divisions of [[1, 1, 1], [2, 2, 2], [3, 2, 2], [4, 4, 4]] as [number, number, number][]) {
    it(`has the area of the cross-section with divisions ${divisions.join('x')}, at every position`, () => {
      const state = row(3);
      for (let k = 1; k < 30; k++) {
        const at = 3 * k / 30;
        for (const keep of ['above', 'below'] as const) {
          const cut: SectionCut = { axis: 0, at, keep };
          const view = buildSolverView({ state, setup: setupOf(divisions), result: null, field: 'none', deformationScale: 0, opacity: 1, section: cut });
          const cap = view.root.children.find(c => c.userData['sectionCap']) as THREE.Mesh | undefined;
          const area = cap ? capArea(cap).area : 0;
          // when the plane lies exactly on the faces of elements the cap is not needed: the faces themselves are the cut
          const onFaces = Math.abs(at * divisions[0] - Math.round(at * divisions[0])) < 1e-9;
          if (onFaces) expect(area).withContext(`${divisions} at ${at} ${keep}`).toBeCloseTo(0, 6);
          else expect(area).withContext(`${divisions} at ${at} ${keep}`).toBeCloseTo(1, 4);
          disposeMeshView(view);
        }
      }
    });
  }

  it('shows the cut surface itself when the plane lies exactly on the faces of elements (it used to vanish: the faces were thrown out by rounding)', () => {
    const state = row(3);
    for (const keep of ['above', 'below'] as const) {
      const view = buildSolverView({ state, setup: setupOf([2, 2, 2]), result: null, field: 'none', deformationScale: 0, opacity: 1, section: { axis: 0, at: 1.5, keep } });
      const body = (view.pickables as THREE.Mesh[]).map(m => m.geometry.getAttribute('position'));
      const xs = body.flatMap(p => Array.from({ length: p.count }, (_, i) => p.getX(i)));
      const onPlane = xs.filter(x => Math.abs(x - 1.5) < 1e-5);
      // faces lie in the plane (the cut), and nothing is beyond it
      expect(onPlane.length).withContext(keep).toBeGreaterThan(20);
      expect(keep === 'above' ? Math.min(...xs) : Math.max(...xs)).withContext(keep).toBeCloseTo(1.5, 5);
      disposeMeshView(view);
    }
  });
});
