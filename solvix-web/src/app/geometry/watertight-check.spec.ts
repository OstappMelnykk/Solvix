import * as THREE from 'three';
import { findHoleBoundaryClusters, findHoleBoundaryEdges, findHoleBoundaryLoops, isWatertight } from './watertight-check';

describe('isWatertight', () => {
  it('returns true for a closed box mesh (vertices welded across face seams)', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    expect(isWatertight(group)).toBe(true);
  });

  it('returns false for an open plane mesh (boundary edges)', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)));
    expect(isWatertight(group)).toBe(false);
  });

  it('returns false when the object contains no meshes', () => {
    expect(isWatertight(new THREE.Group())).toBe(false);
  });

  it('returns false if any mesh among several is open', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)));
    expect(isWatertight(group)).toBe(false);
  });
});

describe('findHoleBoundaryEdges', () => {
  it('finds no boundary edges on a closed box', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    group.updateMatrixWorld(true);
    expect(findHoleBoundaryEdges(group)).toEqual([]);
  });

  it('finds exactly the boundary loop (4 edges) of an open plane', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)));
    group.updateMatrixWorld(true);
    expect(findHoleBoundaryEdges(group).length).toBe(4);
  });

  it("places boundary edge points in the object's own local/world space", () => {
    const group = new THREE.Group();
    group.position.set(5, 0, 0);
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)));
    group.updateMatrixWorld(true);
    const edges = findHoleBoundaryEdges(group);
    // group has no parent, so matrixWorld === local matrix - a child mesh's
    // own vertex at local x=-0.5 lands at world x=4.5, not -0.5.
    const xs = edges.flatMap(edge => [edge.a.x, edge.b.x]);
    expect(Math.min(...xs)).toBeCloseTo(4.5);
    expect(Math.max(...xs)).toBeCloseTo(5.5);
  });
});

describe('findHoleBoundaryLoops', () => {
  it('finds no loops on a closed box', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    group.updateMatrixWorld(true);
    expect(findHoleBoundaryLoops(group)).toEqual([]);
  });

  it('chains an open plane\'s 4 boundary edges into a single closed 4-point loop', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)));
    group.updateMatrixWorld(true);
    const loops = findHoleBoundaryLoops(group);
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(4);
  });

  it('finds one loop per hole for 2 separate open planes', () => {
    const group = new THREE.Group();
    const planeA = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    const planeB = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    planeB.position.set(10, 0, 0);
    group.add(planeA, planeB);
    group.updateMatrixWorld(true);
    const loops = findHoleBoundaryLoops(group);
    expect(loops.length).toBe(2);
    expect(loops[0].length).toBe(4);
    expect(loops[1].length).toBe(4);
  });
});

describe('findHoleBoundaryClusters', () => {
  it('finds no clusters on a closed box', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    group.updateMatrixWorld(true);
    expect(findHoleBoundaryClusters(group)).toEqual([]);
  });

  it('groups an open plane\'s boundary into a single cluster', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)));
    group.updateMatrixWorld(true);
    const clusters = findHoleBoundaryClusters(group);
    expect(clusters.length).toBe(1);
    expect(clusters[0].length).toBe(4);
  });

  it('finds one cluster per hole for 2 separate open planes', () => {
    const group = new THREE.Group();
    const planeA = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    const planeB = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    planeB.position.set(10, 0, 0);
    group.add(planeA, planeB);
    group.updateMatrixWorld(true);
    expect(findHoleBoundaryClusters(group).length).toBe(2);
  });
});