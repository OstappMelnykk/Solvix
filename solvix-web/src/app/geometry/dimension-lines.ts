import * as THREE from 'three';

const LINE_COLOR = 0xffcc33;
const LABEL_COLOR = '#ffcc33';

// Draftsman-style dimension lines (extension line + witness line + end
// ticks + a text label) along all 3 axes of `box`, built in the SAME local,
// pivot-centered frame as the reference mesh itself (see
// ImportedGeometryService/ImportedReferenceRenderService) - the returned
// group is meant to have the reference's own position+quaternion copied
// onto it afterward, so it rotates rigidly along with the object instead of
// staying axis-aligned to world space. `box` should already reflect the
// current display scale (caller multiplies) - the label prints that SAME
// scaled length, matching the "Розмір" control exactly. Not the raw file's
// own units: those are frequently meaningless anyway (.stl has no embedded
// unit at all - could be mm, inches, anything), so the one number that's
// actually reliable and means something to the user is whatever size
// they've told the reference to display at.
export function buildDimensionLines(box: THREE.Box3): THREE.Object3D {
  const group = new THREE.Group();

  const min = box.min;
  const max = box.max;
  const size = new THREE.Vector3().subVectors(max, min);
  const margin = Math.max(size.x, size.y, size.z, 1e-6) * 0.15 + 0.05;
  const tick = margin * 0.3;

  const positions: number[] = [];
  const addSegment = (a: THREE.Vector3, b: THREE.Vector3): void => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  };
  const displayedLength = (axis: 'x' | 'y' | 'z'): number => size[axis];

  // X - offset outward along +Y and +Z from the box's max corner.
  {
    const y = max.y + margin;
    const z = max.z + margin;
    const a = new THREE.Vector3(min.x, y, z);
    const b = new THREE.Vector3(max.x, y, z);
    addSegment(new THREE.Vector3(min.x, max.y, max.z), a);
    addSegment(new THREE.Vector3(max.x, max.y, max.z), b);
    addSegment(a, b);
    addSegment(new THREE.Vector3(a.x, a.y - tick, a.z - tick), new THREE.Vector3(a.x, a.y + tick, a.z + tick));
    addSegment(new THREE.Vector3(b.x, b.y - tick, b.z - tick), new THREE.Vector3(b.x, b.y + tick, b.z + tick));
    const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, tick * 2, tick * 2));
    group.add(buildLabel(formatLength(displayedLength('x')), mid, margin));
  }
  // Y - offset outward along +X and +Z.
  {
    const x = max.x + margin;
    const z = max.z + margin;
    const a = new THREE.Vector3(x, min.y, z);
    const b = new THREE.Vector3(x, max.y, z);
    addSegment(new THREE.Vector3(max.x, min.y, max.z), a);
    addSegment(new THREE.Vector3(max.x, max.y, max.z), b);
    addSegment(a, b);
    addSegment(new THREE.Vector3(a.x - tick, a.y, a.z - tick), new THREE.Vector3(a.x + tick, a.y, a.z + tick));
    addSegment(new THREE.Vector3(b.x - tick, b.y, b.z - tick), new THREE.Vector3(b.x + tick, b.y, b.z + tick));
    const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(tick * 2, 0, tick * 2));
    group.add(buildLabel(formatLength(displayedLength('y')), mid, margin));
  }
  // Z - offset outward along +X and +Y.
  {
    const x = max.x + margin;
    const y = max.y + margin;
    const a = new THREE.Vector3(x, y, min.z);
    const b = new THREE.Vector3(x, y, max.z);
    addSegment(new THREE.Vector3(max.x, max.y, min.z), a);
    addSegment(new THREE.Vector3(max.x, max.y, max.z), b);
    addSegment(a, b);
    addSegment(new THREE.Vector3(a.x - tick, a.y - tick, a.z), new THREE.Vector3(a.x + tick, a.y + tick, a.z));
    addSegment(new THREE.Vector3(b.x - tick, b.y - tick, b.z), new THREE.Vector3(b.x + tick, b.y + tick, b.z));
    const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(tick * 2, tick * 2, 0));
    group.add(buildLabel(formatLength(displayedLength('z')), mid, margin));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: LINE_COLOR })));

  return group;
}

function formatLength(value: number): string {
  return value.toFixed(2);
}

// A billboard text label (canvas-texture Sprite, always faces the camera -
// no font/TextGeometry dependency needed) - `margin` sizes it proportional
// to the dimension lines it's labeling, so it reads at a sensible size
// whether the reference is tiny or huge.
function buildLabel(text: string, position: THREE.Vector3, margin: number): THREE.Sprite {
  const fontSize = 64;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${fontSize}px sans-serif`;
  const textWidth = ctx.measureText(text).width;
  canvas.width = Math.ceil(textWidth) + 16;
  canvas.height = fontSize + 16;
  // Sizing the canvas resets the context, so the font has to be reapplied.
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = LABEL_COLOR;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.position.copy(position);
  const height = margin * 0.8;
  sprite.scale.set((canvas.width / canvas.height) * height, height, 1);
  return sprite;
}

export function disposeDimensionLines(object: THREE.Object3D): void {
  object.traverse(child => {
    if (child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      child.material.dispose();
    } else if (child instanceof THREE.Sprite) {
      child.material.map?.dispose();
      child.material.dispose();
    }
  });
}