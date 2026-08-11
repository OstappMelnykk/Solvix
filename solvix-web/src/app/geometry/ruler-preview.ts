import * as THREE from 'three';

const RULER_COLOR = 0x5ac85a;
const TICK_LENGTH_FACTOR = 0.15;

// A green segment running parallel to the imported object's longest
// bounding-box edge, subdivided into `density` equal ticks - a visual
// "this many unit-of-density segments fit along this side" measuring tape,
// separate from the numeric axis dimension lines (geometry/dimension-lines.ts).
//
// `box`: the object's ACTUAL bounding box (already at whatever scale it's
// being shown at) - NOT assumed centered at the origin, even though in
// practice it currently always is (ImportedGeometryService recenters on
// import) - positioning the ruler from `size` alone would silently assume
// that and draw the ruler somewhere the object isn't if that ever changes.
//
// `distance`: how far past the object's own surface the ruler sits, along
// that surface's normal - a user-controlled input, not a fixed fraction of
// the object's size. The ruler starts exactly at that face (`box.max`
// along the offset axis) and then moves out by `distance`.
export function buildRulerPreview(box: THREE.Box3, longestAxis: 0 | 1 | 2, density: number, distance: number): THREE.Object3D {
  const min = [box.min.x, box.min.y, box.min.z];
  const max = [box.max.x, box.max.y, box.max.z];
  const sizes = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const length = sizes[longestAxis];
  const maxSize = Math.max(...sizes);
  const tickLength = maxSize * TICK_LENGTH_FACTOR;

  // Perpendicular axes: offsetAxisIndex is the face normal the ruler moves
  // along (the object's "positive" face on that axis), tickAxisIndex draws
  // the perpendicular tick marks. Y (index 1, "up") is avoided as the offset
  // axis whenever there's a choice - the ruler sits beside the object in the
  // horizontal plane, not floating above it. Y only becomes the offset axis
  // when it's the only option left (longestAxis itself is Y).
  const [offsetAxisIndex, tickAxisIndex] = longestAxis === 0 ? [2, 1] : longestAxis === 1 ? [0, 2] : [0, 1];
  const offset = max[offsetAxisIndex] + Math.max(0, distance);

  const axis = (index: number): THREE.Vector3 => new THREE.Vector3(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0);
  const lengthAxis = axis(longestAxis);
  const offsetAxis = axis(offsetAxisIndex);
  const tickAxis = axis(tickAxisIndex);

  const start = offsetAxis.clone().multiplyScalar(offset).addScaledVector(lengthAxis, min[longestAxis]);
  const material = new THREE.LineBasicMaterial({ color: RULER_COLOR });
  const group = new THREE.Group();

  const points = [start, start.clone().addScaledVector(lengthAxis, length)];
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));

  const tickCount = Math.max(1, Math.round(density));
  for (let i = 0; i <= tickCount; i++) {
    const center = start.clone().addScaledVector(lengthAxis, (length * i) / tickCount);
    const tickPoints = [
      center.clone().addScaledVector(tickAxis, -tickLength / 2),
      center.clone().addScaledVector(tickAxis, tickLength / 2)
    ];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tickPoints), material));
  }

  return group;
}

// Frees the GPU resources of a preview built above. Every Line in the group
// shares the SAME material instance (created once in buildRulerPreview), so
// it must be disposed exactly once, not per-line.
export function disposeRulerPreview(object: THREE.Object3D): void {
  const disposedMaterials = new Set<THREE.Material>();
  object.traverse(child => {
    if (!(child instanceof THREE.Line)) {
      return;
    }
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach(material => {
      if (!disposedMaterials.has(material)) {
        disposedMaterials.add(material);
        material.dispose();
      }
    });
  });
}