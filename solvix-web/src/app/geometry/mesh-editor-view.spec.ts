import * as THREE from 'three';
import { MeshFaceDto } from '../api/mesh-editor-api.service';
import { FACE_NAMES, LOCAL_COORDS, MeshPick, buildMeshView, disposeMeshView, faceAxis, faceSign, faceSlots, mapHex, nodePosition, shapeFunctions20 } from './mesh-editor-view';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

const noSelection = { hexes: [], face: null, hoverFace: null, nodeId: null };

function picks(pickables: THREE.Object3D[]): MeshPick[] {
  return pickables.map(o => o.userData['pick'] as MeshPick);
}

describe('mesh-editor-view', () => {
  describe('face helpers', () => {
    it('derive axis and side from the face name', () => {
      expect(FACE_NAMES.map(faceAxis)).toEqual([0, 0, 1, 1, 2, 2]);
      expect(FACE_NAMES.map(faceSign)).toEqual([-1, 1, -1, 1, -1, 1]);
    });

    it('list the 8 slots of each face (4 corners then midpoints, all on that face)', () => {
      for (const face of FACE_NAMES) {
        const slots = faceSlots(face);
        expect(slots.length).toBe(8);
        expect(slots.filter(s => s < 8).length).toBe(4);
      }
      expect(faceSlots('XPlus')).toEqual([1, 2, 5, 6, 9, 13, 17, 18]);
    });
  });

  describe('nodePosition', () => {
    const node = { id: 1, x: 0.25, y: 0.5, z: 0.75, idealX: 3, idealY: 4, idealZ: 5 };

    it('uses the real coordinates in the real world', () => {
      expect(nodePosition(node, 'real').toArray()).toEqual([0.25, 0.5, 0.75]);
    });

    it('uses the doubled ideal coordinates halved in the ideal world', () => {
      expect(nodePosition(node, 'ideal').toArray()).toEqual([1.5, 2, 2.5]);
    });
  });

  describe('buildMeshView', () => {
    it('makes 6 faces and 20 nodes pickable for a single cube, and draws 12 curved edges', () => {
      const view = buildMeshView(singleCubeState(), 'real', noSelection);

      const kinds = picks(view.pickables).map(p => p.kind);
      expect(kinds.filter(k => k === 'face').length).toBe(6);
      expect(kinds.filter(k => k === 'node').length).toBe(20);
      const edges = view.root.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments;
      expect(edges.geometry.getAttribute('position').count).toBe(12 * 10 * 2);
    });

    it('draws a linked face once, so two hexes do not z-fight', () => {
      const view = buildMeshView(linkedPairState(), 'real', noSelection);

      const faces = picks(view.pickables).filter(p => p.kind === 'face');
      expect(faces.length).toBe(11); // 12 faces, the shared one only once
      expect(faces.some(f => f.kind === 'face' && f.hex === 1 && f.face === 'XMinus')).toBeFalse();
      expect(faces.some(f => f.kind === 'face' && f.hex === 0 && f.face === 'XPlus')).toBeTrue();
      expect(picks(view.pickables).filter(p => p.kind === 'node').length).toBe(32);
    });

    it('draws both sides of a candidate pair whose faces do not coincide, and one when they do', () => {
      const state = linkedPairState();
      const asCandidates = (coincident: boolean) => ({
        ...state,
        faces: state.faces.map((f): MeshFaceDto =>
          f.status === 'Linked' ? { ...f, status: 'Candidate', coincident, gap: coincident ? 0 : 0.3 } : f)
      });
      const sharedFaces = (view: ReturnType<typeof buildMeshView>) =>
        picks(view.pickables).filter(p => p.kind === 'face' && (p.face === 'XPlus' || p.face === 'XMinus') && ((p.hex === 0 && p.face === 'XPlus') || (p.hex === 1 && p.face === 'XMinus')));

      expect(sharedFaces(buildMeshView(asCandidates(false), 'real', noSelection)).length).toBe(2);
      expect(sharedFaces(buildMeshView(asCandidates(true), 'real', noSelection)).length).toBe(1);
    });

    it('places the nodes at real positions in the real world and on the lattice in the ideal world', () => {
      const state = singleCubeState();
      state.nodes.find(n => n.id === 6); // corner (+,+,+) at (1,1,1)
      const moved = { ...state, nodes: state.nodes.map(n => (n.id === 6 ? { ...n, x: 1.5, y: 0.8, z: 1.2 } : n)) };

      const real = buildMeshView(moved, 'real', noSelection);
      const ideal = buildMeshView(moved, 'ideal', noSelection);

      const nodeAt = (view: ReturnType<typeof buildMeshView>, id: number) =>
        view.pickables.find(o => (o.userData['pick'] as MeshPick).kind === 'node' && (o.userData['pick'] as { nodeId: number }).nodeId === id)!;
      expect(nodeAt(real, 6).position.toArray()).toEqual([1.5, 0.8, 1.2]);
      expect(nodeAt(ideal, 6).position.toArray()).toEqual([1, 1, 1]);
    });

    it('bends an edge through its midpoint node', () => {
      const state = singleCubeState();
      // edge 0-1 has midpoint slot 8; lift it
      const bent = { ...state, nodes: state.nodes.map(n => (n.id === 8 ? { ...n, z: n.z + 0.2 } : n)) };

      const view = buildMeshView(bent, 'real', noSelection);

      const edges = view.root.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments;
      const position = edges.geometry.getAttribute('position');
      // edge 0 is drawn first: 10 segments of 2 vertices; the end of segment 4 is t = 0, the midpoint node
      const mid = new THREE.Vector3().fromBufferAttribute(position, 4 * 2 + 1);
      expect(mid.x).toBeCloseTo(0.5, 6);
      expect(mid.z).toBeCloseTo(0.2, 6);
    });

    it('colours a picked cube and a selected node differently from the rest', () => {
      const plain = buildMeshView(singleCubeState(), 'real', noSelection);
      const selected = buildMeshView(singleCubeState(), 'real', { hexes: [0], face: null, hoverFace: null, nodeId: 3 });

      const colorOf = (view: ReturnType<typeof buildMeshView>, match: (p: MeshPick) => boolean) => {
        const object = view.pickables.find(o => match(o.userData['pick'] as MeshPick)) as THREE.Mesh;
        return (object.material as THREE.MeshBasicMaterial).color.getHex();
      };
      const nodeColor = (view: ReturnType<typeof buildMeshView>, id: number) =>
        (view.nodeMeshes.get(id)!.material as THREE.MeshBasicMaterial).color.getHex();
      const isFace = (p: MeshPick) => p.kind === 'face' && p.face === 'XPlus';

      expect(colorOf(selected, isFace)).not.toBe(colorOf(plain, isFace));
      expect(nodeColor(selected, 3)).not.toBe(nodeColor(plain, 3));
      expect(nodeColor(selected, 4)).toBe(nodeColor(plain, 4));
      expect(colorOf(selected, p => p.kind === 'face' && p.face === 'YPlus')).not.toBe(colorOf(plain, p => p.kind === 'face' && p.face === 'YPlus'));
    });

    it('colours free, linked and candidate faces differently', () => {
      const state = linkedPairState();
      const view = buildMeshView(state, 'real', noSelection);
      const colorOf = (hex: number, face: string) => {
        const object = view.pickables.find(o => {
          const p = o.userData['pick'] as MeshPick;
          return p.kind === 'face' && p.hex === hex && p.face === face;
        }) as THREE.Mesh;
        return (object.material as THREE.MeshBasicMaterial).color.getHex();
      };

      expect(colorOf(0, 'XPlus')).not.toBe(colorOf(0, 'XMinus'));
    });

    it('builds an empty root for a state with no hexes', () => {
      const view = buildMeshView({ ...singleCubeState(), nodes: [], hexes: [], faces: [] }, 'real', noSelection);

      expect(view.pickables).toEqual([]);
      expect(view.root.children).toEqual([]);
    });

    it('samples a face with the 8-node surface through its corner nodes', () => {
      const view = buildMeshView(singleCubeState(), 'real', noSelection);
      const face = view.pickables.find(o => {
        const p = o.userData['pick'] as MeshPick;
        return p.kind === 'face' && p.face === 'XPlus';
      }) as THREE.Mesh;

      const position = face.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        expect(position.getX(i)).toBeCloseTo(1, 6);
      }
      const box = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
      expect(box.min.y).toBeCloseTo(0, 6);
      expect(box.max.y).toBeCloseTo(1, 6);
      expect(box.min.z).toBeCloseTo(0, 6);
      expect(box.max.z).toBeCloseTo(1, 6);
    });
  });

  describe('cube selection colours', () => {
    const faceColor = (view: ReturnType<typeof buildMeshView>, hex: number, face: string) => {
      const object = view.pickables.find(o => {
        const p = o.userData['pick'] as MeshPick;
        return p.kind === 'face' && p.hex === hex && p.face === face;
      }) as THREE.Mesh;
      return (object.material as THREE.MeshBasicMaterial).color.getHex();
    };

    it('tints every drawn face of the base cube and of the adapting cube differently', () => {
      const state = linkedPairState();
      const view = buildMeshView(state, 'real', { hexes: [0, 1], face: null, hoverFace: null, nodeId: null });
      const plain = buildMeshView(state, 'real', noSelection);

      const base = faceColor(view, 0, 'YPlus');
      const adapting = faceColor(view, 1, 'YPlus');
      expect(base).not.toBe(adapting);
      expect(base).not.toBe(faceColor(plain, 0, 'YPlus'));
      expect(adapting).not.toBe(faceColor(plain, 1, 'YPlus'));
      // every face of the base shares one colour
      expect(faceColor(view, 0, 'ZPlus')).toBe(base);
    });

    it('colours the shared face by the base cube whichever side is drawn', () => {
      const state = linkedPairState();   // the shared face is drawn from hex 0's side

      const baseIsOne = buildMeshView(state, 'real', { hexes: [1, 0], face: null, hoverFace: null, nodeId: null });
      const baseIsZero = buildMeshView(state, 'real', { hexes: [0, 1], face: null, hoverFace: null, nodeId: null });
      const onlyOne = buildMeshView(state, 'real', { hexes: [1], face: null, hoverFace: null, nodeId: null });

      // the same pair, but roles swapped: the shared face follows the base (index 0)
      expect(faceColor(baseIsOne, 0, 'XPlus')).toBe(faceColor(baseIsZero, 0, 'XPlus'));
      // picking only cube 1 still tints the shared face drawn from cube 0's side
      expect(faceColor(onlyOne, 0, 'XPlus')).not.toBe(faceColor(buildMeshView(state, 'real', noSelection), 0, 'XPlus'));
    });

    it('swapping the roles swaps the colours of the two cubes', () => {
      const state = linkedPairState();
      const a = buildMeshView(state, 'real', { hexes: [0, 1], face: null, hoverFace: null, nodeId: null });
      const b = buildMeshView(state, 'real', { hexes: [1, 0], face: null, hoverFace: null, nodeId: null });

      expect(faceColor(a, 0, 'YPlus')).toBe(faceColor(b, 1, 'YPlus'));
      expect(faceColor(a, 1, 'YPlus')).toBe(faceColor(b, 0, 'YPlus'));
    });

    it('draws a picked face in its own colour, apart from cube picks and statuses', () => {
      const state = singleCubeState();
      const view = buildMeshView(state, 'real', { hexes: [], face: { hex: 0, face: 'XPlus' }, hoverFace: null, nodeId: null });
      const plain = buildMeshView(state, 'real', noSelection);
      const cube = buildMeshView(state, 'real', { hexes: [0], face: null, hoverFace: null, nodeId: null });

      expect(faceColor(view, 0, 'XPlus')).not.toBe(faceColor(plain, 0, 'XPlus'));
      expect(faceColor(view, 0, 'XPlus')).not.toBe(faceColor(cube, 0, 'XPlus'));
      expect(faceColor(view, 0, 'YPlus')).toBe(faceColor(plain, 0, 'YPlus'));   // only the clicked face
    });

    it('draws the hovered face as a preview, apart from selection and status colours', () => {
      const state = singleCubeState();
      const view = buildMeshView(state, 'real', { hexes: [0], face: null, hoverFace: { hex: 0, face: 'XPlus' }, nodeId: null });
      const picked = buildMeshView(state, 'real', { hexes: [0], face: null, hoverFace: null, nodeId: null });

      expect(faceColor(view, 0, 'XPlus')).not.toBe(faceColor(picked, 0, 'XPlus'));
      expect(faceColor(view, 0, 'YPlus')).toBe(faceColor(picked, 0, 'YPlus'));
    });
  });

  describe('node targets', () => {
    it('has a visible dot per node and a larger invisible pick sphere around it', () => {
      const view = buildMeshView(singleCubeState(), 'real', noSelection);

      expect(view.nodeMeshes.size).toBe(20);
      const hit = view.pickables.find(o => (o.userData['pick'] as MeshPick).kind === 'node' && (o.userData['pick'] as { nodeId: number }).nodeId === 6) as THREE.Mesh;
      const dot = view.nodeMeshes.get(6)!;
      hit.geometry.computeBoundingSphere();
      dot.geometry.computeBoundingSphere();
      expect(hit.position.toArray()).toEqual(dot.position.toArray());
      expect(hit.geometry.boundingSphere!.radius).toBeGreaterThan(dot.geometry.boundingSphere!.radius * 2);
      expect((hit.material as THREE.MeshBasicMaterial).opacity).toBe(0);
      expect(view.pickables.includes(dot)).toBeFalse();
    });
  });

  describe('disposeMeshView', () => {
    it('disposes every geometry and material exactly once', () => {
      const view = buildMeshView(singleCubeState(), 'real', noSelection);
      const geometries = new Set<THREE.BufferGeometry>();
      view.root.traverse(c => {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) geometries.add(c.geometry);
      });
      const spies = [...geometries].map(g => spyOn(g, 'dispose').and.callThrough());

      disposeMeshView(view);

      spies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    });
  });

  describe('shape functions (drawing only)', () => {
    // independent transcription of the solver's N20 (AdaptiveMethods/Solution1 viewer / Solution2 FemRunner)
    const referenceN20 = (a: number, b: number, g: number): number[] => {
      const ca = [-1, 1, 1, -1, -1, 1, 1, -1];
      const cb = [-1, -1, 1, 1, -1, -1, 1, 1];
      const cg = [-1, -1, -1, -1, 1, 1, 1, 1];
      const n = new Array<number>(20).fill(0);
      for (let i = 0; i < 8; i++) {
        n[i] = 0.125 * (1 + ca[i] * a) * (1 + cb[i] * b) * (1 + cg[i] * g) * (ca[i] * a + cb[i] * b + cg[i] * g - 2);
      }
      n[8] = 0.25 * (1 - a * a) * (1 - b) * (1 - g);
      n[9] = 0.25 * (1 + a) * (1 - b * b) * (1 - g);
      n[10] = 0.25 * (1 - a * a) * (1 + b) * (1 - g);
      n[11] = 0.25 * (1 - a) * (1 - b * b) * (1 - g);
      n[12] = 0.25 * (1 - a * a) * (1 - b) * (1 + g);
      n[13] = 0.25 * (1 + a) * (1 - b * b) * (1 + g);
      n[14] = 0.25 * (1 - a * a) * (1 + b) * (1 + g);
      n[15] = 0.25 * (1 - a) * (1 - b * b) * (1 + g);
      n[16] = 0.25 * (1 - a) * (1 - b) * (1 - g * g);
      n[17] = 0.25 * (1 + a) * (1 - b) * (1 - g * g);
      n[18] = 0.25 * (1 + a) * (1 + b) * (1 - g * g);
      n[19] = 0.25 * (1 - a) * (1 + b) * (1 - g * g);
      return n;
    };

    it('match the solver N20 at random points', () => {
      let seed = 7;
      const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2.4 - 1.2;
      for (let p = 0; p < 200; p++) {
        const [a, b, c] = [random(), random(), random()];
        const mine = shapeFunctions20(a, b, c);
        const ref = referenceN20(a, b, c);
        for (let i = 0; i < 20; i++) expect(mine[i]).toBeCloseTo(ref[i], 12);
      }
    });

    it('are one at their own node, zero at the others, and sum to one', () => {
      for (let i = 0; i < 20; i++) {
        const phi = shapeFunctions20(...LOCAL_COORDS[i]);
        phi.forEach((value, j) => expect(value).toBeCloseTo(i === j ? 1 : 0, 12));
      }
      expect(shapeFunctions20(0.3, -0.6, 0.45).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12);
    });

    it('map a point of the cube through the 20 node positions: node slots reproduce their own positions', () => {
      const positions = LOCAL_COORDS.map(([a, b, g], i) => new THREE.Vector3(10 + a * 2 + i * 0.01, 20 + b, 30 + g * 3));

      LOCAL_COORDS.forEach(([a, b, g], i) => expect(mapHex(positions, a, b, g).distanceTo(positions[i])).toBeLessThan(1e-12));
    });
  });

  describe('inner grid', () => {
    const segmentsOf = (view: ReturnType<typeof buildMeshView>) =>
      view.root.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);

    it('is off by default: only the cube edges are lines', () => {
      expect(segmentsOf(buildMeshView(singleCubeState(), 'real', noSelection)).length).toBe(1);
      expect(segmentsOf(buildMeshView(singleCubeState(), 'real', noSelection, { subdivisions: 1 })).length).toBe(1);
    });

    it('draws the interior lines for n = 2: 5 per axis, 12 samples each', () => {
      const view = buildMeshView(singleCubeState(), 'real', noSelection, { subdivisions: 2 });

      const lines = segmentsOf(view);
      expect(lines.length).toBe(2);
      expect(lines[1].geometry.getAttribute('position').count).toBe(3 * 5 * 12 * 2);
    });

    it('a straight cube gives straight, evenly spaced lines through the cube', () => {
      const view = buildMeshView(singleCubeState(), 'real', noSelection, { subdivisions: 2 });
      const position = segmentsOf(view)[1].geometry.getAttribute('position');

      const xs = new Set<number>();
      for (let i = 0; i < position.count; i++) xs.add(Math.round(position.getX(i) * 1e6) / 1e6);
      expect([...xs].some(x => Math.abs(x - 0.5) < 1e-6)).toBeTrue();   // the middle plane
    });

    it('bends with the nodes: lifting an edge midpoint curves the grid lines near it', () => {
      const state = singleCubeState();
      const bent = { ...state, nodes: state.nodes.map(n => (n.id === 8 ? { ...n, z: n.z + 0.3 } : n)) };
      const plain = segmentsOf(buildMeshView(state, 'real', noSelection, { subdivisions: 3 }))[1].geometry.getAttribute('position');
      const curved = segmentsOf(buildMeshView(bent, 'real', noSelection, { subdivisions: 3 }))[1].geometry.getAttribute('position');

      let moved = 0;
      for (let i = 0; i < plain.count; i++) {
        if (Math.abs(plain.getZ(i) - curved.getZ(i)) > 1e-6) moved++;
      }
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThan(plain.count);
    });

    it('in the ideal world the grid stays on the lattice whatever the real nodes do', () => {
      const state = singleCubeState();
      const bent = { ...state, nodes: state.nodes.map(n => (n.id === 8 ? { ...n, z: n.z + 0.3 } : n)) };
      const a = segmentsOf(buildMeshView(state, 'ideal', noSelection, { subdivisions: 3 }))[1].geometry.getAttribute('position');
      const b = segmentsOf(buildMeshView(bent, 'ideal', noSelection, { subdivisions: 3 }))[1].geometry.getAttribute('position');

      for (let i = 0; i < a.count; i++) {
        expect(b.getX(i)).toBeCloseTo(a.getX(i), 6);
        expect(b.getY(i)).toBeCloseTo(a.getY(i), 6);
        expect(b.getZ(i)).toBeCloseTo(a.getZ(i), 6);
      }
    });

    it('ignores nonsense subdivision counts', () => {
      expect(segmentsOf(buildMeshView(singleCubeState(), 'real', noSelection, { subdivisions: 0 })).length).toBe(1);
      expect(segmentsOf(buildMeshView(singleCubeState(), 'real', noSelection, { subdivisions: 1.7 })).length).toBe(1);
    });
  });
});
