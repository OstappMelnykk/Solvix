import * as THREE from 'three';

// Binary wire format for Solvix.Api's POST /api/meshes/voxelize -
// switched from JSON after a real STL (2.9M triangles) produced a ~690MB
// JSON body against the endpoint's 300MB request-size cap; the same mesh
// encoded this way is ~140MB (12 bytes/vertex + 4 bytes/index instead of
// ~70 bytes per JSON {"x":...,"y":...,"z":...} object). Mirrors
// Solvix.Voxelization's internal MeshBinarySerializer, which is the only
// reader of this format - Solvix.Api's controller and Solvix.MeshBuilder's
// facade both just pass these bytes through unopened. Explicit
// little-endian via DataView (not a raw Float32Array/Uint32Array view,
// whose byte order follows the host platform) so the layout is unambiguous
// regardless of the reading side's architecture - it matches .NET's
// BinaryReader, which is always little-endian. Layout:
//   [uint32 vertexCount]
//   [uint32 indexCount]
//   [vertexCount * 3 float32, x,y,z interleaved]
//   [indexCount * uint32]
// No vertex welding (every triangle corner gets its own vertex+index,
// indices are always the identity 0..vertexCount-1) - the BE algorithm
// doesn't care whether vertices are shared, only simpler and impossible to
// get wrong than reproducing watertight-check.ts's welding here too.
export function toMeshBinary(object: THREE.Object3D): ArrayBuffer {
  object.updateMatrixWorld(true);

  // Counted up front so the output buffer can be allocated exactly once,
  // instead of growing a JS array of millions of intermediate values.
  let cornerCount = 0;
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      const position = child.geometry.getAttribute('position');
      if (position) {
        cornerCount += child.geometry.index ? child.geometry.index.count : position.count;
      }
    }
  });

  const vertexBytes = cornerCount * 3 * 4;
  const indexBytes = cornerCount * 4;
  const buffer = new ArrayBuffer(8 + vertexBytes + indexBytes);
  const view = new DataView(buffer);
  view.setUint32(0, cornerCount, true);
  view.setUint32(4, cornerCount, true);

  const vertexBase = 8;
  const indexBase = vertexBase + vertexBytes;
  const point = new THREE.Vector3();
  let corner = 0;

  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const geometry = child.geometry;
    const position = geometry.getAttribute('position');
    if (!position) {
      return;
    }
    const triangleIndices = geometry.index ? geometry.index.array : Array.from({ length: position.count }, (_, i) => i);

    for (let i = 0; i < triangleIndices.length; i++) {
      point.fromBufferAttribute(position, triangleIndices[i]).applyMatrix4(child.matrixWorld);
      const vertexOffset = vertexBase + corner * 12;
      view.setFloat32(vertexOffset, point.x, true);
      view.setFloat32(vertexOffset + 4, point.y, true);
      view.setFloat32(vertexOffset + 8, point.z, true);
      view.setUint32(indexBase + corner * 4, corner, true);
      corner++;
    }
  });

  return buffer;
}