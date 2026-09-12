import * as THREE from 'three';

// Frees GPU resources (geometry + material(s)) for every Mesh, LineSegments,
// or BatchedMesh found anywhere in the object's subtree - the shared
// disposal shape every feature that builds throwaway three.js geometry
// needs (ImportedGeometryService and orphaned-import cleanup in
// settings-panel.component.ts, and geometry/scene-objects/voxels.ts's fill/edges/
// nodes, geometry/voxel-hexahedron.ts's standalone single-cube builder).
// BatchedMesh gets its own branch because it isn't just "a mesh with a
// geometry" - THREE.BatchedMesh.dispose() frees its own internally-managed
// merged geometry/textures and must be called instead of (not in addition
// to) `.geometry.dispose()`.
export function disposeObject3D(object: THREE.Object3D): void {
  object.traverse(child => {
    if (child instanceof THREE.BatchedMesh) {
      child.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    } else if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    }
  });
}