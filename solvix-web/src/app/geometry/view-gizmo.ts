import * as THREE from 'three';

// The gizmo of a node in one of the six orthographic views, in pixels of the panel: a handle at the node itself (a free
// move in the plane of the view) and an arrow for each world axis that lies in that plane (a move along the axis).

export type GizmoAxis = 'x' | 'y' | 'z';

export interface GizmoArrow {
  readonly axis: GizmoAxis;
  // the world direction of the axis, a unit vector
  readonly direction: THREE.Vector3;
  // where the arrow runs on the panel
  readonly from: THREE.Vector2;
  readonly to: THREE.Vector2;
}

export interface Gizmo {
  readonly centre: THREE.Vector2;
  readonly arrows: readonly GizmoArrow[];
}

export type GizmoHit = { readonly kind: 'centre' } | { readonly kind: 'axis'; readonly axis: GizmoAxis; readonly direction: THREE.Vector3 };

const AXES: readonly { axis: GizmoAxis; direction: THREE.Vector3 }[] = [
  { axis: 'x', direction: new THREE.Vector3(1, 0, 0) },
  { axis: 'y', direction: new THREE.Vector3(0, 1, 0) },
  { axis: 'z', direction: new THREE.Vector3(0, 0, 1) }
];

function toPixels(world: THREE.Vector3, camera: THREE.Camera, width: number, height: number): THREE.Vector2 {
  const ndc = world.clone().project(camera);
  return new THREE.Vector2(((ndc.x + 1) / 2) * width, ((1 - ndc.y) / 2) * height);
}

// The gizmo of a node at `position`, for a panel of `width` x `height` pixels seen by `camera`. Arrows are `length`
// pixels long; an axis that points at or away from the camera (so it has no length on the screen) has no arrow.
export function gizmoFor(camera: THREE.Camera, width: number, height: number, position: THREE.Vector3, length = 70): Gizmo {
  camera.updateMatrixWorld(true);
  const centre = toPixels(position, camera, width, height);
  const arrows: GizmoArrow[] = [];
  for (const { axis, direction } of AXES) {
    const tip = toPixels(position.clone().add(direction), camera, width, height).sub(centre);
    if (tip.length() < 1e-6) continue;
    const to = centre.clone().add(tip.normalize().multiplyScalar(length));
    arrows.push({ axis, direction: direction.clone(), from: centre.clone(), to });
  }
  return { centre, arrows };
}

function distanceToSegment(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, ab.lengthSq() === 0 ? 0 : p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return p.distanceTo(a.clone().add(ab.multiplyScalar(t)));
}

// What the pointer at `pixel` grabs: the centre (a generous round handle, checked first, for a free move), an arrow (only
// beyond `arrowStart` pixels from the centre, so that a press on or near the node is never an axis drag by accident), or
// nothing.
export function hitGizmo(gizmo: Gizmo, pixel: THREE.Vector2, centreRadius = 12, arrowRadius = 6, arrowStart = 18): GizmoHit | null {
  if (pixel.distanceTo(gizmo.centre) <= centreRadius) return { kind: 'centre' };
  let best: { hit: GizmoHit; distance: number } | null = null;
  for (const arrow of gizmo.arrows) {
    const along = arrow.to.clone().sub(arrow.from);
    const length = along.length();
    if (length <= arrowStart) continue;
    const begin = arrow.from.clone().add(along.multiplyScalar(arrowStart / length));
    const distance = distanceToSegment(pixel, begin, arrow.to);
    if (distance <= arrowRadius && (best === null || distance < best.distance)) best = { hit: { kind: 'axis', axis: arrow.axis, direction: arrow.direction }, distance };
  }
  return best?.hit ?? null;
}

// The node nearest to a point of the panel, among those within `radius` pixels of it - whatever is in front of it. In an
// orthographic view the cubes cover each other, so a node is found by where it is on the screen, not by a ray that the
// faces in front would stop.
export function nearestNodeOnScreen(
  nodes: Iterable<[number, THREE.Vector3]>,
  camera: THREE.Camera,
  width: number,
  height: number,
  pixel: THREE.Vector2,
  radius = 14
): { nodeId: number; distance: number } | null {
  camera.updateMatrixWorld(true);
  let best: { nodeId: number; distance: number } | null = null;
  for (const [nodeId, position] of nodes) {
    const distance = toPixels(position, camera, width, height).distanceTo(pixel);
    if (distance <= radius && (best === null || distance < best.distance)) best = { nodeId, distance };
  }
  return best;
}
