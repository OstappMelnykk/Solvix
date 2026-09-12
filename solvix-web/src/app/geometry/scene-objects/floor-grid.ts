import * as THREE from 'three';

const GRID_SIZE = 50;
const GRID_DIVISIONS = 50;

// Floor grid on the XZ plane (Y=0) - a fixed scene fixture (not per-
// session/model), purely a visual reference for scale/orientation.
// Visibility is user-toggleable (WorldCanvasComponent.toggleGridVisible),
// which is why the caller keeps its own reference to the returned object
// rather than this file tracking visibility itself.
export function buildFloorGrid(): THREE.GridHelper {
  return new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS);
}
