import * as THREE from 'three';
import { EDGE_CORNERS, edgeCurves, edgeMoveSets, withEdgeMoved } from './mesh-editor-view';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

// withEdgeMoved mirrors the backend's HexMesh.MoveEdge: the 2 corners and the midpoint of the edge move by the full delta, the midpoints of the other edges that leave
// the 2 corners (in every cube that owns one) by half, everything else stays put.
describe('withEdgeMoved', () => {
  const EDGE = 4;       // the edge (4, 5)

  it('moves the edge fully and the midpoints of the edges leaving its corners by half', () => {
    const state = singleCubeState();
    const hex = state.hexes[0];
    const before = new Map(state.nodes.map(n => [n.id, { x: n.x, y: n.y, z: n.z }]));
    const delta = { x: 0, y: 0.3, z: 0.2 };

    const moved = withEdgeMoved(state, 0, EDGE, delta);
    const after = new Map(moved.nodes.map(n => [n.id, n]));
    const sets = edgeMoveSets(state, 0, EDGE)!;

    expect(sets.full.size).toBe(3);
    expect(sets.half.size).toBe(4);                      // the 2 other edges that leave each of the 2 corners
    expect(sets.full.has(hex.nodeIds[4]) && sets.full.has(hex.nodeIds[5]) && sets.full.has(hex.nodeIds[8 + EDGE])).toBeTrue();
    for (const [id, start] of before) {
      const scale = sets.full.has(id) ? 1 : sets.half.has(id) ? 0.5 : 0;
      const node = after.get(id)!;
      expect(node.y).toBeCloseTo(start.y + delta.y * scale, 12);
      expect(node.z).toBeCloseTo(start.z + delta.z * scale, 12);
    }
  });

  it('keeps every edge of every cube straight when the edge is shared', () => {
    const state = linkedPairState();
    const shared = EDGE_CORNERS.findIndex(([a, b]) => a === 1 && b === 2);
    const moved = withEdgeMoved(state, 0, shared, { x: 0.3, y: -0.1, z: 0.2 });
    const node = new Map(moved.nodes.map(n => [n.id, n]));

    for (const hex of moved.hexes)
      EDGE_CORNERS.forEach(([a, b], k) => {
        const [pa, pb, pm] = [node.get(hex.nodeIds[a])!, node.get(hex.nodeIds[b])!, node.get(hex.nodeIds[8 + k])!];
        expect(pm.x).withContext(`cube ${hex.id} edge ${k}`).toBeCloseTo((pa.x + pb.x) / 2, 9);
        expect(pm.y).withContext(`cube ${hex.id} edge ${k}`).toBeCloseTo((pa.y + pb.y) / 2, 9);
        expect(pm.z).withContext(`cube ${hex.id} edge ${k}`).toBeCloseTo((pa.z + pb.z) / 2, 9);
      });
  });

  it('leaves the state alone for an unknown cube or edge', () => {
    const state = singleCubeState();
    expect(withEdgeMoved(state, 99, 0, { x: 1, y: 0, z: 0 })).toBe(state);
    expect(withEdgeMoved(state, 0, 12, { x: 1, y: 0, z: 0 })).toBe(state);
  });
});

describe('edgeCurves', () => {
  it('gives the 12 edges of a cube, and an edge two linked cubes share only once', () => {
    expect(edgeCurves(singleCubeState(), 'real').length).toBe(12);
    expect(edgeCurves(linkedPairState(), 'real').length).toBe(20);      // 24 edges, the 4 of the shared face counted once
  });

  it('runs a curve from one corner through the midpoint to the other', () => {
    const [curve] = edgeCurves(singleCubeState(), 'real', 8);
    expect(curve.points.length).toBe(9);
    const state = singleCubeState();
    const hex = state.hexes[0];
    const [a, b] = EDGE_CORNERS[curve.edge];
    const node = (id: number) => state.nodes.find(n => n.id === id)!;
    expect(curve.points[0].distanceTo(new THREE.Vector3(node(hex.nodeIds[a]).x, node(hex.nodeIds[a]).y, node(hex.nodeIds[a]).z))).toBeLessThan(1e-9);
    expect(curve.points[8].distanceTo(new THREE.Vector3(node(hex.nodeIds[b]).x, node(hex.nodeIds[b]).y, node(hex.nodeIds[b]).z))).toBeLessThan(1e-9);
  });
});
