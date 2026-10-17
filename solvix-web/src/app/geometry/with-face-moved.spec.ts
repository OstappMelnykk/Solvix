import { withFaceMoved, withFacesMoved, faceSlots, EDGE_CORNERS } from './mesh-editor-view';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

// withFaceMoved mirrors the backend's HexMesh.MoveFace: the 8 nodes on the face
// move by the full delta, the midpoints of the edges joining the face to the
// opposite one move by half, everything else stays put.
describe('withFaceMoved', () => {
  it('moves the 8 face nodes fully and the connecting midpoints by half', () => {
    const state = singleCubeState();
    const hex = state.hexes[0];
    const before = new Map(state.nodes.map(n => [n.id, { x: n.x, y: n.y, z: n.z }]));
    const delta = { x: 0.3, y: 0, z: 0 };

    const moved = withFaceMoved(state, 0, 'XPlus', delta);
    const after = new Map(moved.nodes.map(n => [n.id, n]));

    const onFace = new Set(faceSlots('XPlus'));
    const fullIds = new Set([...onFace].map(slot => hex.nodeIds[slot]));
    const halfIds = new Set<number>();
    EDGE_CORNERS.forEach(([a, b], k) => {
      if (onFace.has(a) !== onFace.has(b)) {
        const id = hex.nodeIds[8 + k];
        if (!fullIds.has(id)) halfIds.add(id);
      }
    });

    for (const [id, start] of before) {
      const node = after.get(id)!;
      const scale = fullIds.has(id) ? 1 : halfIds.has(id) ? 0.5 : 0;
      expect(node.x).toBeCloseTo(start.x + delta.x * scale, 12);
      expect(node.y).toBeCloseTo(start.y + delta.y * scale, 12);
      expect(node.z).toBeCloseTo(start.z + delta.z * scale, 12);
    }

    // Sanity: there really are 8 full and 4 half nodes on a free cube's face.
    expect(fullIds.size).toBe(8);
    expect(halfIds.size).toBe(4);
  });

  it('returns the state unchanged for an unknown hex', () => {
    const state = singleCubeState();
    expect(withFaceMoved(state, 999, 'XPlus', { x: 1, y: 0, z: 0 })).toBe(state);
  });

  it('keeps the edges of the linked neighbour straight too when the face is shared', () => {
    const state = linkedPairState();
    const moved = withFaceMoved(state, 0, 'XPlus', { x: 0.4, y: 0.1, z: -0.2 });
    const node = new Map(moved.nodes.map(n => [n.id, n]));

    for (const hex of moved.hexes)
      EDGE_CORNERS.forEach(([a, b], k) => {
        const [pa, pb, pm] = [node.get(hex.nodeIds[a])!, node.get(hex.nodeIds[b])!, node.get(hex.nodeIds[8 + k])!];
        expect(pm.x).withContext(`cube ${hex.id} edge ${k}`).toBeCloseTo((pa.x + pb.x) / 2, 9);
        expect(pm.y).withContext(`cube ${hex.id} edge ${k}`).toBeCloseTo((pa.y + pb.y) / 2, 9);
        expect(pm.z).withContext(`cube ${hex.id} edge ${k}`).toBeCloseTo((pa.z + pb.z) / 2, 9);
      });
  });

  it('several faces move together: a node of both moves once, by the whole delta', () => {
    const state = linkedPairState();
    const delta = { x: 0.2, y: 0.1, z: 0 };
    const one = withFacesMoved(state, [{ hex: state.hexes[0].id, face: 'YPlus' }], delta);
    const same = withFaceMoved(state, state.hexes[0].id, 'YPlus', delta);
    expect(one.nodes).toEqual(same.nodes);

    const both = withFacesMoved(state, [{ hex: state.hexes[0].id, face: 'YPlus' }, { hex: state.hexes[0].id, face: 'XPlus' }], delta);
    const hex = state.hexes[0];
    const shared = new Set(faceSlots('YPlus').filter(s => faceSlots('XPlus').includes(s)).map(s => hex.nodeIds[s]));
    expect(shared.size).toBeGreaterThan(0);
    const before = new Map(state.nodes.map(n => [n.id, n]));
    for (const n of both.nodes) {
      if (!shared.has(n.id)) continue;
      expect(n.x).toBeCloseTo(before.get(n.id)!.x + delta.x, 12);
    }
  });
});
