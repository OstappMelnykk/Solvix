import * as THREE from 'three';
import { gizmoFor, hitGizmo } from './view-gizmo';

function ortho(eye: THREE.Vector3, up: THREE.Vector3): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.copy(eye);
  camera.up.copy(up);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

describe('the gizmo of a node in a view', () => {
  const origin = new THREE.Vector3(0, 0, 0);

  it('has an arrow for each axis that lies in the plane of the view, and none for the one pointing at the camera', () => {
    const front = gizmoFor(ortho(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 1, 0)), 400, 400, origin);
    const top = gizmoFor(ortho(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, 0, -1)), 400, 400, origin);
    const side = gizmoFor(ortho(new THREE.Vector3(10, 0, 0), new THREE.Vector3(0, 1, 0)), 400, 400, origin);

    expect(front.arrows.map(a => a.axis)).toEqual(['x', 'y']);
    expect(top.arrows.map(a => a.axis)).toEqual(['x', 'z']);
    expect(side.arrows.map(a => a.axis)).toEqual(['y', 'z']);
  });

  it('puts the centre where the node is on the panel and the arrows the given number of pixels long along the axes', () => {
    const gizmo = gizmoFor(ortho(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 1, 0)), 400, 400, new THREE.Vector3(1, 1, 0), 60);

    expect(gizmo.centre.x).toBeCloseTo(300, 6);                  // [-2, 2] over 400 px: world 1 is at 300
    expect(gizmo.centre.y).toBeCloseTo(100, 6);                  // and up is towards smaller y
    const x = gizmo.arrows.find(a => a.axis === 'x')!;
    const y = gizmo.arrows.find(a => a.axis === 'y')!;
    expect(x.to.x - x.from.x).toBeCloseTo(60, 6);
    expect(x.to.y - x.from.y).toBeCloseTo(0, 6);
    expect(y.to.y - y.from.y).toBeCloseTo(-60, 6);
  });

  it('follows the view: for a camera looking from the other side the arrow points the other way', () => {
    const back = gizmoFor(ortho(new THREE.Vector3(0, 0, -10), new THREE.Vector3(0, 1, 0)), 400, 400, origin, 50);
    const x = back.arrows.find(a => a.axis === 'x')!;

    expect(x.to.x - x.from.x).toBeCloseTo(-50, 6);               // world +X goes to the left seen from behind
    expect(x.direction.toArray()).toEqual([1, 0, 0]);            // but it is still the +X axis that is dragged
  });

  describe('what the pointer grabs', () => {
    const gizmo = gizmoFor(ortho(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 1, 0)), 400, 400, origin, 70);     // centre (200, 200)

    it('the centre first, even where the arrows begin', () => {
      expect(hitGizmo(gizmo, new THREE.Vector2(203, 198))).toEqual({ kind: 'centre' });
    });

    it('an arrow along its length, with its axis', () => {
      const x = hitGizmo(gizmo, new THREE.Vector2(250, 203));
      const y = hitGizmo(gizmo, new THREE.Vector2(197, 150));

      expect(x?.kind === 'axis' && x.axis).toBe('x');
      expect(y?.kind === 'axis' && y.axis).toBe('y');
    });

    it('nothing beside the arrows or beyond their tips', () => {
      expect(hitGizmo(gizmo, new THREE.Vector2(250, 240))).toBeNull();
      expect(hitGizmo(gizmo, new THREE.Vector2(290, 200))).toBeNull();
      expect(hitGizmo(gizmo, new THREE.Vector2(10, 10))).toBeNull();
    });
  });
});
