import * as THREE from 'three';

// Frees a Mesh's GPU resources (geometry + material(s)) for every Mesh found
// anywhere in the object's subtree - the shared disposal shape
// ImportedGeometryService and orphaned-import cleanup (settings-panel.component.ts,
// for a load that resolved after its session was already closed) both need.
export function disposeObject3D(object: THREE.Object3D): void {
  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach(material => material.dispose());
  });
}