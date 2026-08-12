import * as THREE from 'three';
import { computeMeshStats } from './mesh-stats';

function indexedBox(): THREE.Mesh {
  // BoxGeometry is indexed by default: 24 vertices, 36 indices (12 triangles).
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
}

describe('computeMeshStats', () => {
  it('counts a single indexed mesh', () => {
    const stats = computeMeshStats(indexedBox());
    expect(stats.meshCount).toBe(1);
    expect(stats.vertexCount).toBe(24);
    expect(stats.triangleCount).toBe(12);
  });

  it('sums stats across every mesh in a group', () => {
    const group = new THREE.Group();
    group.add(indexedBox());
    group.add(indexedBox());

    const stats = computeMeshStats(group);

    expect(stats.meshCount).toBe(2);
    expect(stats.vertexCount).toBe(48);
    expect(stats.triangleCount).toBe(24);
  });

  it('counts a non-indexed mesh via position count / 3', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array(9).fill(0), 3)); // 3 verts, no index
    const mesh = new THREE.Mesh(geometry);

    const stats = computeMeshStats(mesh);

    expect(stats.meshCount).toBe(1);
    expect(stats.vertexCount).toBe(3);
    expect(stats.triangleCount).toBe(1);
  });

  it('returns all zeros for an object with no meshes', () => {
    const group = new THREE.Group();
    group.add(new THREE.Object3D());

    const stats = computeMeshStats(group);

    expect(stats.meshCount).toBe(0);
    expect(stats.vertexCount).toBe(0);
    expect(stats.triangleCount).toBe(0);
  });

  it('skips a mesh whose geometry has no position attribute', () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry());

    const stats = computeMeshStats(mesh);

    expect(stats.meshCount).toBe(0);
  });
});