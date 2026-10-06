import * as THREE from 'three';

// Dragging a node inside one of the six orthographic views: the node can only
// slide in the plane of that view (the plane through its starting point,
// perpendicular to the view direction), so the move is exact in two
// coordinates and untouched in the third - no free 3D drag to aim.
export class NodeDrag {
  readonly plane: THREE.Plane;
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    readonly nodeId: number,
    readonly start: THREE.Vector3,
    private readonly camera: THREE.Camera
  ) {
    const direction = camera.getWorldDirection(new THREE.Vector3());
    this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(direction, start);
  }

  // The node's position for a pointer at `ndc` (normalised device coordinates
  // of the panel). With `lockAxis` it keeps only the larger of the two screen-
  // axis components, so the node moves along one axis of the view.
  positionFor(ndc: THREE.Vector2, lockAxis: boolean): THREE.Vector3 {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!hit) {
      return this.start.clone();
    }
    if (!lockAxis) {
      return hit;
    }
    const delta = hit.sub(this.start);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    const along = delta.dot(right);
    const across = delta.dot(up);
    return this.start.clone().add(Math.abs(along) >= Math.abs(across) ? right.multiplyScalar(along) : up.multiplyScalar(across));
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
