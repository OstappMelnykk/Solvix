import * as THREE from 'three';

// The cell of the integer lattice on the ground (the plane y = 0) under a ray from the camera, or null when the ray does
// not come down onto the ground. A cell is one unit wide: (i, 0, k) is the cube with its corner at (i, 0, k) - the cell
// the first cube can be put in.
export interface GroundCell {
  readonly i: number;
  readonly j: 0;
  readonly k: number;
}

export function groundCellUnder(ray: THREE.Ray): GroundCell | null {
  if (ray.direction.y >= -1e-9) return null;                  // looking level or up: never reaches the ground
  const t = -ray.origin.y / ray.direction.y;
  if (t <= 0) return null;                                    // the ground is behind the camera
  return { i: Math.floor(ray.origin.x + t * ray.direction.x), j: 0, k: Math.floor(ray.origin.z + t * ray.direction.z) };
}
