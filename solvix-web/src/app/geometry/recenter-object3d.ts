import * as THREE from 'three';

// Shifts `object.position` so its world-space bounding-box center lands
// exactly at the origin. Must be reapplied after ANYTHING that changes the
// object's own transform (e.g. scaling a clone) - the position offset that
// centers it at one scale does NOT keep it centered at another (world
// center = position + scale * localCenter, so a position computed to
// cancel localCenter at scale=1 drifts by localCenter * (scale - 1) once
// scale changes), so this recomputes the offset fresh each time rather
// than assuming a previously-centered object stays centered.
export function recenterAtOrigin(object: THREE.Object3D): void {
  object.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  object.position.sub(center);
  object.updateMatrixWorld(true);
}