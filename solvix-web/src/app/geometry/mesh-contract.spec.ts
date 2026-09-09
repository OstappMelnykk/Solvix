import * as THREE from 'three';
import { toMeshBinary } from './mesh-contract';

// Mirrors Solvix.Voxelization's internal MeshBinarySerializer's reading
// side, just enough to assert on what toMeshBinary produced without
// re-implementing it.
function readMesh(buffer: ArrayBuffer): { vertices: { x: number; y: number; z: number }[]; indices: number[] } {
  const view = new DataView(buffer);
  const vertexCount = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);

  const vertices = [];
  for (let i = 0; i < vertexCount; i++) {
    const offset = 8 + i * 12;
    vertices.push({ x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) });
  }

  const indexBase = 8 + vertexCount * 12;
  const indices = [];
  for (let i = 0; i < indexCount; i++) {
    indices.push(view.getUint32(indexBase + i * 4, true));
  }

  return { vertices, indices };
}

describe('toMeshBinary', () => {
  it('flattens an indexed mesh into one fresh vertex per triangle corner (no welding)', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); // indexed: 24 verts, 36 indices

    const { vertices, indices } = readMesh(toMeshBinary(mesh));

    expect(vertices.length).toBe(36);
    expect(indices.length).toBe(36);
    expect(indices).toEqual(Array.from({ length: 36 }, (_, i) => i));
  });

  it("bakes the mesh's world transform into the emitted vertex positions", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(5, 6, 7);

    const { vertices } = readMesh(toMeshBinary(mesh));

    expect(vertices).toEqual([{ x: 5, y: 6, z: 7 }]);
  });

  it("collects every mesh under a group, applying each one's own world transform", () => {
    const geometryA = new THREE.BufferGeometry();
    geometryA.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const meshA = new THREE.Mesh(geometryA);
    meshA.position.set(1, 0, 0);

    const geometryB = new THREE.BufferGeometry();
    geometryB.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const meshB = new THREE.Mesh(geometryB);
    meshB.position.set(2, 0, 0);

    const group = new THREE.Group();
    group.add(meshA);
    group.add(meshB);

    const { vertices } = readMesh(toMeshBinary(group));

    expect(vertices).toEqual([
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 }
    ]);
  });

  it('handles a non-indexed mesh by treating vertex order as the index order', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const mesh = new THREE.Mesh(geometry);

    const { vertices, indices } = readMesh(toMeshBinary(mesh));

    expect(vertices.length).toBe(3);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('returns an empty (header-only) buffer for an object with no meshes', () => {
    const buffer = toMeshBinary(new THREE.Group());

    expect(buffer.byteLength).toBe(8);
    const { vertices, indices } = readMesh(buffer);
    expect(vertices).toEqual([]);
    expect(indices).toEqual([]);
  });
});