import * as THREE from 'three';
import { groundCellUnder } from './ground-cell';

describe('groundCellUnder', () => {
  it('names the cell of the ground a ray comes down on', () => {
    expect(groundCellUnder(new THREE.Ray(new THREE.Vector3(2.5, 3, 4.2), new THREE.Vector3(0, -1, 0)))).toEqual({ i: 2, j: 0, k: 4 });
  });

  it('counts a slanted ray where it lands, and cells at negative coordinates the same way', () => {
    // from (0, 4, 0) towards (+1, -1, -2) per unit of drop: lands at (4, 0, -8)
    expect(groundCellUnder(new THREE.Ray(new THREE.Vector3(0, 4, 0), new THREE.Vector3(1, -1, -2).normalize()))).toEqual({ i: 4, j: 0, k: -8 });
    expect(groundCellUnder(new THREE.Ray(new THREE.Vector3(-0.5, 1, -0.5), new THREE.Vector3(0, -1, 0)))).toEqual({ i: -1, j: 0, k: -1 });
  });

  it('puts the line between two cells into the one on its larger side', () => {
    expect(groundCellUnder(new THREE.Ray(new THREE.Vector3(3, 1, 3), new THREE.Vector3(0, -1, 0)))).toEqual({ i: 3, j: 0, k: 3 });
  });

  it('has no cell for a ray that looks level or up, or from below the ground', () => {
    expect(groundCellUnder(new THREE.Ray(new THREE.Vector3(0, 2, 0), new THREE.Vector3(1, 0, 0)))).toBeNull();
    expect(groundCellUnder(new THREE.Ray(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 1, 0)))).toBeNull();
    expect(groundCellUnder(new THREE.Ray(new THREE.Vector3(0, -2, 0), new THREE.Vector3(0, -1, 0)))).toBeNull();
  });
});
