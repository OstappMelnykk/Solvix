import * as THREE from 'three';

// Dragging a node inside one of the six orthographic views: the node can only
// slide in the plane of that view (the plane through its starting point,
// perpendicular to the view direction), so the move is exact in two
// coordinates and untouched in the third - no free 3D drag to aim. Grabbed by an
// arrow of the gizmo it moves along that axis only.
export class NodeDrag {
  readonly plane: THREE.Plane;
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    readonly nodeId: number,
    readonly start: THREE.Vector3,
    private readonly camera: THREE.Camera,
    // the world axis (a unit vector) the node is held to, or null for a free move in the plane of the view
    readonly axis: THREE.Vector3 | null = null
  ) {
    const direction = camera.getWorldDirection(new THREE.Vector3());
    this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(direction, start);
  }

  // The node's position for a pointer at `ndc` (normalised device coordinates of the panel): anywhere in the plane
  // of the view, or - for an axis drag - on the axis through the starting point, as far along it as the pointer is.
  // `lockScreenAxis` (used by the cube constructor's views) keeps only the larger of the two screen components of a
  // free move.
  positionFor(ndc: THREE.Vector2, lockScreenAxis = false): THREE.Vector3 {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!hit) {
      return this.start.clone();
    }
    if (!this.axis) {
      if (!lockScreenAxis) return hit;
      const delta = hit.sub(this.start);
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
      const across = delta.dot(right);
      const vertical = delta.dot(up);
      return this.start.clone().add(Math.abs(across) >= Math.abs(vertical) ? right.multiplyScalar(across) : up.multiplyScalar(vertical));
    }
    const along = hit.sub(this.start).dot(this.axis);
    return this.start.clone().addScaledVector(this.axis, along);
  }
}

// Position rounded to micro-units, the precision the editor sends and shows.
export function roundedPosition(position: THREE.Vector3): { x: number; y: number; z: number } {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return { x: round(position.x), y: round(position.y), z: round(position.z) };
}

export function positionText(position: THREE.Vector3): string {
  const { x, y, z } = roundedPosition(position);
  return `X ${x.toFixed(3)}  Y ${y.toFixed(3)}  Z ${z.toFixed(3)}`;
}
