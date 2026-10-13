import * as THREE from 'three';
import { NodeDrag, positionText, roundedPosition } from './mesh-editor-drag';

function orthoCamera(eye: THREE.Vector3, up: THREE.Vector3): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.copy(eye);
  camera.up.copy(up);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

describe('NodeDrag', () => {
  it('moves the node in the plane of the view and keeps the depth coordinate (looking along -Z)', () => {
    const camera = orthoCamera(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 1, 0));
    const drag = new NodeDrag(7, new THREE.Vector3(0.5, 0.25, 0.8), camera);

    // ndc (0.5, -0.5) on a view spanning [-2,2]^2 is world (1, -1)
    const position = drag.positionFor(new THREE.Vector2(0.5, -0.5));

    expect(position.x).toBeCloseTo(1, 9);
    expect(position.y).toBeCloseTo(-1, 9);
    expect(position.z).toBeCloseTo(0.8, 9);
  });

  it('keeps the third coordinate for a view from above too (looking along -Y)', () => {
    const camera = orthoCamera(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, 0, -1));
    const drag = new NodeDrag(1, new THREE.Vector3(0.3, 0.7, 0.2), camera);

    const position = drag.positionFor(new THREE.Vector2(-0.5, 0.5));

    expect(position.y).toBeCloseTo(0.7, 9);
    expect(position.x).toBeCloseTo(-1, 9);
    expect(position.z).toBeCloseTo(-1, 9);   // up on screen is -Z for this camera
  });

  it('a pointer exactly over the node leaves it where it is', () => {
    const camera = orthoCamera(new THREE.Vector3(10, 0, 0), new THREE.Vector3(0, 1, 0));
    const start = new THREE.Vector3(0.4, 0.6, -0.5);
    const drag = new NodeDrag(1, start, camera);
    const projected = start.clone().project(camera);

    const position = drag.positionFor(new THREE.Vector2(projected.x, projected.y));

    expect(position.distanceTo(start)).toBeLessThan(1e-9);
  });

  it('for the constructor\'s views, a free move can keep only the larger screen component', () => {
    const camera = orthoCamera(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 1, 0));
    const drag = new NodeDrag(1, new THREE.Vector3(0, 0, 0), camera);

    const mostlyAcross = drag.positionFor(new THREE.Vector2(0.5, 0.1), true);
    expect(mostlyAcross.x).toBeCloseTo(1, 9);
    expect(mostlyAcross.y).toBeCloseTo(0, 9);
    const mostlyUp = drag.positionFor(new THREE.Vector2(0.1, -0.5), true);
    expect(mostlyUp.x).toBeCloseTo(0, 9);
    expect(mostlyUp.y).toBeCloseTo(-1, 9);
  });

  it('held to an axis it moves along that axis only, however the pointer strays', () => {
    const camera = orthoCamera(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 1, 0));
    const along = new NodeDrag(1, new THREE.Vector3(0, 0, 0), camera, new THREE.Vector3(1, 0, 0));
    const up = new NodeDrag(1, new THREE.Vector3(0, 0, 0), camera, new THREE.Vector3(0, 1, 0));

    const pointer = new THREE.Vector2(0.5, 0.25);              // world (1, 0.5)
    expect(along.positionFor(pointer).toArray()).toEqual([1, 0, 0]);
    expect(up.positionFor(pointer).toArray()).toEqual([0, 0.5, 0]);
  });

  it('held to an axis it goes both ways and keeps the depth coordinate', () => {
    const camera = orthoCamera(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, 0, -1));
    const drag = new NodeDrag(1, new THREE.Vector3(0.3, 0.7, 0.2), camera, new THREE.Vector3(0, 0, 1));

    const position = drag.positionFor(new THREE.Vector2(0.9, 0.5));        // up on screen is -Z for this camera: world z = -1

    expect(position.x).toBeCloseTo(0.3, 9);
    expect(position.y).toBeCloseTo(0.7, 9);
    expect(position.z).toBeCloseTo(-1, 9);
  });

  it('the drag plane passes through the start and faces the camera', () => {
    const camera = orthoCamera(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 1, 0));
    const start = new THREE.Vector3(1, 2, 3);
    const drag = new NodeDrag(1, start, camera);

    expect(drag.plane.distanceToPoint(start)).toBeCloseTo(0, 9);
    expect(Math.abs(drag.plane.normal.z)).toBeCloseTo(1, 9);
  });

  it('rounds positions to micro-units and formats them for display', () => {
    const p = new THREE.Vector3(1.23456789, -0.0000004, 2);

    expect(roundedPosition(p)).toEqual({ x: 1.234568, y: -0, z: 2 });
    expect(positionText(p)).toBe('X 1.235  Y 0.000  Z 2.000');
  });
});
