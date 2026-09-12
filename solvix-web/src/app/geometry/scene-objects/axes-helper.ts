import * as THREE from 'three';

const AXES_LENGTH = 50;

// Standard THREE.js axis colors: X red, Y green, Z blue - a fixed scene
// fixture (not per-session/model), same lifetime as the whole
// WorldCanvasComponent, so it needs no cleanup/disposal logic of its own.
export function buildAxesHelper(): THREE.AxesHelper {
  return new THREE.AxesHelper(AXES_LENGTH);
}
