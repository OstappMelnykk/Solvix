import * as THREE from 'three';
import { buildPickHighlight } from './pick-highlight';
import { linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

describe('buildPickHighlight', () => {
  it('covers a face with a red coat lying on the face, and outlines it', () => {
    const group = buildPickHighlight(singleCubeState(), 'real', { kind: 'face', hex: 0, face: 'XPlus' })!;
    const coat = group.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;

    expect(group.children.length).toBe(2);                                  // the coat and its outline
    const position = coat.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) expect(position.getX(i)).toBeCloseTo(1, 9);      // the +x face of the unit cube
    expect((coat.material as THREE.MeshBasicMaterial).color.r).toBeGreaterThan(0.9);
  });

  it('puts the coat on the face in either world, and follows a cube that is not a unit one', () => {
    const state = linkedPairState();
    const real = buildPickHighlight(state, 'real', { kind: 'face', hex: 1, face: 'YPlus' })!.children[0] as THREE.Mesh;
    const ideal = buildPickHighlight(state, 'ideal', { kind: 'face', hex: 1, face: 'YPlus' })!.children[0] as THREE.Mesh;

    for (const mesh of [real, ideal]) {
      const position = mesh.geometry.getAttribute('position');
      const ys = Array.from({ length: position.count }, (_, i) => position.getY(i));
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-9);          // a flat face at one height
    }
    const xs = (m: THREE.Mesh) => Array.from({ length: m.geometry.getAttribute('position').count }, (_, i) => m.geometry.getAttribute('position').getX(i));
    expect(Math.min(...xs(real))).toBeGreaterThanOrEqual(0.99);              // the second cube of the pair lies on x from 1 to 2
  });

  it('draws an edge as one red line, and nothing for a node, an unknown cube or an unknown edge', () => {
    const state = singleCubeState();
    expect(buildPickHighlight(state, 'real', { kind: 'edge', hex: 0, edge: 3 })!.children.length).toBe(1);
    expect(buildPickHighlight(state, 'real', { kind: 'node', nodeId: 2 })).toBeNull();
    expect(buildPickHighlight(state, 'real', { kind: 'face', hex: 9, face: 'XPlus' })).toBeNull();
    expect(buildPickHighlight(state, 'real', { kind: 'edge', hex: 0, edge: 40 })).toBeNull();
  });
});
