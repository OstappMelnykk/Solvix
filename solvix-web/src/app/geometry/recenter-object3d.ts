import * as THREE from 'three';

// Shifts `object.position` so its world-space bounding box is centered on
// X/Z but sits with its bottom (min Y) exactly at 0 - i.e. resting on the
// floor grid (Y=0) rather than floating with its vertical center there.
// Must be reapplied after ANYTHING that changes the object's own transform
// (e.g. scaling a clone) - the position offset that achieves this at one
// scale does NOT hold at another (world position = position + scale *
// localOffset, so an offset computed at scale=1 drifts by
// localOffset * (scale - 1) once scale changes), so this recomputes the
// offset fresh each time rather than assuming a previously-placed object
// stays placed.
export function recenterAtOrigin(object: THREE.Object3D): void {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.y -= box.min.y;
  object.position.z -= center.z;
  object.updateMatrixWorld(true);
}