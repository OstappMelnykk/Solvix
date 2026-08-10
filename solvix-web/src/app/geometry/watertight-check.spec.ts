import * as THREE from 'three';
import { isWatertight } from './watertight-check';

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