import * as THREE from 'three';

// Whether the centre of an object is comfortably in view of a camera (inside the middle part of the screen, in front of
// the camera). A cube put down where the user clicked is: the view then stays as it is instead of jumping to it.
export function centreIsInView(camera: THREE.Camera, object: THREE.Object3D, margin = 0.85): boolean {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return false;
  camera.updateMatrixWorld(true);
  const ndc = box.getCenter(new THREE.Vector3()).project(camera);
  return ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) <= margin && Math.abs(ndc.y) <= margin;
}
