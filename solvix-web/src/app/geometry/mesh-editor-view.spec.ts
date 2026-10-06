import * as THREE from 'three';
import { MeshFaceDto } from '../api/mesh-editor-api.service';
import { FACE_NAMES, MeshPick, buildMeshView, disposeMeshView, faceAxis, faceSign, faceSlots, nodePosition } from './mesh-editor-view';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

const noSelection = { faces: [], nodeId: null };

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

    it('colours a selected face and node differently from the rest', () => {
      const plain = buildMeshView(singleCubeState(), 'real', noSelection);
      const selected = buildMeshView(singleCubeState(), 'real', { faces: [{ hex: 0, face: 'XPlus' }], nodeId: 3 });

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
      expect(colorOf(selected, p => p.kind === 'face' && p.face === 'YPlus')).toBe(colorOf(plain, p => p.kind === 'face' && p.face === 'YPlus'));
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
});
