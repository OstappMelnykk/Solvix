import * as THREE from 'three';
import { gizmoFor, hitGizmo, nearestEdgeOnScreen, nearestNodeOnScreen } from './view-gizmo';

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

    it('the centre first, a round handle larger than the dot, so a press on the node itself is a free move', () => {
      expect(hitGizmo(gizmo, new THREE.Vector2(203, 198))).toEqual({ kind: 'centre' });
      expect(hitGizmo(gizmo, new THREE.Vector2(211, 200))).toEqual({ kind: 'centre' });          // 11 px along the X arrow: still the centre
      expect(hitGizmo(gizmo, new THREE.Vector2(200, 189))).toEqual({ kind: 'centre' });          // and up the Y arrow
    });

    it('an arrow only beyond its start, not next to the node', () => {
      expect(hitGizmo(gizmo, new THREE.Vector2(213, 206))).toBeNull();                            // between the centre handle and the start of the arrow
      expect((hitGizmo(gizmo, new THREE.Vector2(225, 203)) as { axis: string }).axis).toBe('x');
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

describe('the node nearest to the pointer', () => {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  it('finds a node by where it is on the screen, even with another node (or a cube) in front of it', () => {
    const nodes: [number, THREE.Vector3][] = [[1, new THREE.Vector3(0, 0, 5)], [2, new THREE.Vector3(0, 0, -5)], [3, new THREE.Vector3(1, 1, 0)]];

    const found = nearestNodeOnScreen(nodes, camera, 400, 400, new THREE.Vector2(203, 198));

    expect(found?.nodeId === 1 || found?.nodeId === 2).toBeTrue();          // both lie on the same line of sight; either can be had
    expect(nearestNodeOnScreen(nodes, camera, 400, 400, new THREE.Vector2(300, 100))?.nodeId).toBe(3);
  });

  it('takes the closest one within the radius, and nothing beyond it', () => {
    const nodes: [number, THREE.Vector3][] = [[1, new THREE.Vector3(0, 0, 0)], [2, new THREE.Vector3(0.1, 0, 0)]];       // 10 px apart

    expect(nearestNodeOnScreen(nodes, camera, 400, 400, new THREE.Vector2(209, 200))?.nodeId).toBe(2);
    expect(nearestNodeOnScreen(nodes, camera, 400, 400, new THREE.Vector2(201, 200))?.nodeId).toBe(1);
    expect(nearestNodeOnScreen(nodes, camera, 400, 400, new THREE.Vector2(100, 100))).toBeNull();
    expect(nearestNodeOnScreen(nodes, camera, 400, 400, new THREE.Vector2(240, 200), 14)).toBeNull();
  });
});

describe('the edge nearest to a point of a view', () => {
  const camera = ortho(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 1, 0));       // [-2, 2] over 400 px: world 1 is 100 px from the centre
  const curve = (hex: number, edge: number, ...points: number[][]) => ({ hex, edge, points: points.map(p => new THREE.Vector3(...p)) });
  const edges = [curve(0, 1, [-1, 1, 0], [0, 1, 0], [1, 1, 0]), curve(0, 2, [-1, -1, 3], [1, -1, 3])];

  it('finds the edge a click is within the radius of, with how far it is from the camera', () => {
    const near = nearestEdgeOnScreen(edges, camera, 400, 400, new THREE.Vector2(200, 103), 6);   // 3 px below the first edge (y = 1 is at 100 px)

    expect(near?.hex).toBe(0);
    expect(near?.edge).toBe(1);
    expect(near?.distance).toBeCloseTo(3, 6);
    expect(near?.depth).toBeCloseTo(Math.hypot(10, 1), 6);          // the straight distance from the camera, as a ray measures it
  });

  it('finds nothing farther than the radius, and takes the nearer of two', () => {
    expect(nearestEdgeOnScreen(edges, camera, 400, 400, new THREE.Vector2(200, 120), 6)).toBeNull();
    expect(nearestEdgeOnScreen(edges, camera, 400, 400, new THREE.Vector2(200, 297), 6)?.edge).toBe(2);      // y = -1 is at 300 px; this edge is nearer the camera
    expect(nearestEdgeOnScreen(edges, camera, 400, 400, new THREE.Vector2(200, 297), 6)?.depth).toBeCloseTo(Math.hypot(7, 1), 6);
  });

  it('does not take an edge behind what is in front, even if it is nearer on the screen, but the one in front of it', () => {
    const behind = curve(1, 0, [-1, 1, -3], [1, 1, -3]);                      // the same place on the screen as the edge at y = 1, farther from the camera
    const near = nearestEdgeOnScreen([behind, edges[0]], camera, 400, 400, new THREE.Vector2(200, 100), 6, 11);

    expect(near?.edge).toBe(1);                                                // the one in front (depth about 10), not the one at depth 13
    expect(nearestEdgeOnScreen([behind], camera, 400, 400, new THREE.Vector2(200, 100), 6, 11)).toBeNull();
  });

  it('measures to the piece of the curve, not only to its points', () => {
    const near = nearestEdgeOnScreen([curve(5, 0, [-1, 0, 0], [1, 0, 0])], camera, 400, 400, new THREE.Vector2(200, 202), 6);      // between the two points

    expect(near?.distance).toBeCloseTo(2, 6);
  });
});
