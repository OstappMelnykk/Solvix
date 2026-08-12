import * as THREE from 'three';
import { buildRulerPreview, disposeRulerPreview } from './ruler-preview';

function pointsOf(line: THREE.Line): THREE.Vector3[] {
  const position = line.geometry.getAttribute('position');
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    points.push(new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)));
  }
  return points;
}

describe('buildRulerPreview', () => {
  const box = new THREE.Box3(new THREE.Vector3(-1, -0.5, -1.5), new THREE.Vector3(1, 0.5, 1.5));

  it('draws one main line plus (density + 1) tick lines', () => {
    const group = buildRulerPreview(box, 2, 8, 1);

    const lines = group.children.filter(child => child instanceof THREE.Line);
    expect(lines.length).toBe(1 + 9); // main + tickCount(8)+1 ticks
  });

  it('the main line spans exactly the longest-axis extent', () => {
    const group = buildRulerPreview(box, 2, 4, 1);
    const mainLine = group.children[0] as THREE.Line;

    const [start, end] = pointsOf(mainLine);
    expect(end.z - start.z).toBeCloseTo(3, 5); // box.max.z - box.min.z
  });

  it('offsets outward from the object surface by `distance`, along a horizontal axis when longestAxis is Z', () => {
    const group = buildRulerPreview(box, 2, 4, 2.5);
    const mainLine = group.children[0] as THREE.Line;

    const [start] = pointsOf(mainLine);
    // longestAxis=Z(2) -> offset axis is X(0) per the X/Z-avoids-Y-unless-forced rule.
    expect(start.x).toBeCloseTo(box.max.x + 2.5, 5);
    expect(start.z).toBeCloseTo(box.min.z, 5);
  });

  it('never uses Y as the offset axis, even when Y is the longest axis - falls back to X', () => {
    const group = buildRulerPreview(box, 1, 4, 1);
    const mainLine = group.children[0] as THREE.Line;

    const [start] = pointsOf(mainLine);
    expect(start.x).toBeCloseTo(box.max.x + 1, 5);
    expect(start.y).toBeCloseTo(box.min.y, 5);
  });

  it('clamps a negative distance to sit flush on the surface instead of clipping into it', () => {
    const group = buildRulerPreview(box, 2, 4, -5);
    const mainLine = group.children[0] as THREE.Line;

    const [start] = pointsOf(mainLine);
    expect(start.x).toBeCloseTo(box.max.x, 5);
  });

  it('rounds a fractional density to the nearest whole tick count, minimum 1', () => {
    const zero = buildRulerPreview(box, 2, 0, 1);
    const fractional = buildRulerPreview(box, 2, 2.6, 1);

    expect(zero.children.filter(c => c instanceof THREE.Line).length).toBe(1 + 2); // clamped to 1 tickCount -> 2 lines
    expect(fractional.children.filter(c => c instanceof THREE.Line).length).toBe(1 + 4); // rounds to 3 -> 4 lines
  });
});

describe('disposeRulerPreview', () => {
  it('disposes each line geometry and the shared material exactly once', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -0.5, -1.5), new THREE.Vector3(1, 0.5, 1.5));
    const group = buildRulerPreview(box, 2, 4, 1);
    const lines = group.children.filter((child): child is THREE.Line => child instanceof THREE.Line);
    const geometryDisposes = lines.map(line => spyOn(line.geometry, 'dispose'));
    const sharedMaterial = lines[0].material as THREE.Material;
    const materialDispose = spyOn(sharedMaterial, 'dispose');

    disposeRulerPreview(group);

    geometryDisposes.forEach(spy => expect(spy).toHaveBeenCalled());
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });
});