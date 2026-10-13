import * as THREE from 'three';
import { SurfaceSnapper, stick } from './surface-snap';

const plane = (size = 10, y = 0) => {
  // a horizontal square of two triangles at height y, centred on the origin
  const g = new THREE.BufferGeometry();
  const h = size / 2;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-h, y, -h, h, y, -h, h, y, h, -h, y, -h, h, y, h, -h, y, h], 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial());
};

describe('SurfaceSnapper', () => {
  it('projects a point onto the surface straight down, and reports how far it was', () => {
    const snapper = new SurfaceSnapper(plane());

    const hit = snapper.closest(new THREE.Vector3(1, 2, -3))!;

    expect(hit.point.toArray()).toEqual([1, 0, -3]);
    expect(hit.distance).toBeCloseTo(2, 9);
  });

  it('finds the nearest point on an edge or a corner for a point beside the surface', () => {
    const snapper = new SurfaceSnapper(plane());

    expect(snapper.closest(new THREE.Vector3(8, 0, 0))!.point.toArray()).toEqual([5, 0, 0]);          // the edge
    const corner = snapper.closest(new THREE.Vector3(8, 4, 9))!;
    expect(corner.point.toArray()).toEqual([5, 0, 5]);                                                // the corner
    expect(corner.distance).toBeCloseTo(Math.hypot(3, 4, 4), 9);
  });

  it('says nothing is near when the surface is further than the limit, and finds it when it is not', () => {
    const snapper = new SurfaceSnapper(plane());

    expect(snapper.closest(new THREE.Vector3(0, 1, 0), 0.5)).toBeNull();
    expect(snapper.closest(new THREE.Vector3(0, 1, 0), 1.5)!.distance).toBeCloseTo(1, 9);
  });

  it('uses the mesh as it stands in the world: moved, scaled and turned', () => {
    const mesh = plane(2);
    mesh.scale.setScalar(5);                       // 10 wide
    mesh.rotation.x = Math.PI / 2;                 // now a vertical wall in z = 0
    mesh.position.set(0, 3, 0);
    const snapper = new SurfaceSnapper(mesh);

    const hit = snapper.closest(new THREE.Vector3(1, 3.5, 4))!;

    expect(hit.point.x).toBeCloseTo(1, 6);
    expect(hit.point.y).toBeCloseTo(3.5, 6);
    expect(hit.point.z).toBeCloseTo(0, 6);
  });

  it('agrees with a brute-force search on a bumpy surface, from points on all sides', () => {
    const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(3, 3), new THREE.MeshBasicMaterial());
    const snapper = new SurfaceSnapper(sphere);
    expect(snapper.triangleCount).toBeGreaterThan(300);

    for (const p of [new THREE.Vector3(10, 1, -2), new THREE.Vector3(0.5, 0.2, 0.1), new THREE.Vector3(-4, -4, 4), new THREE.Vector3(0, 3.2, 0)]) {
      const hit = snapper.closest(p)!;
      // the true distance to a sphere of radius 3 is |p| - 3 (the mesh is inscribed, so a little more)
      expect(Math.abs(hit.distance - Math.abs(p.length() - 3))).toBeLessThan(0.15);
      expect(hit.point.length()).toBeLessThan(3.0001);
    }
  });

  it('is empty without triangles', () => {
    const snapper = new SurfaceSnapper(new THREE.Group());

    expect(snapper.isEmpty).toBeTrue();
    expect(snapper.closest(new THREE.Vector3())).toBeNull();
    expect(snapper.diagonal).toBe(0);
  });

  it('knows the size of the surface', () => {
    expect(new SurfaceSnapper(plane(10)).diagonal).toBeCloseTo(Math.hypot(10, 0, 10), 6);
  });
});

describe('stick', () => {
  const snapper = new SurfaceSnapper(plane(10));         // the diagonal is about 14.1, so 3% is about 0.42
  const at = (y: number) => new THREE.Vector3(2, y, 1);

  it('sticks a free node dragged close to the surface, at the nearest point', () => {
    const result = stick(snapper, at(0.3), false, false, 0.03);

    expect(result.change).toBe('attach');
    expect(result.point!.toArray()).toEqual([2, 0, 1]);
  });

  it('leaves a free node that is still far from the surface alone', () => {
    const result = stick(snapper, at(2), false, false, 0.03);

    expect(result.change).toBeNull();
    expect(result.point).toBeNull();
  });

  it('keeps a stuck node on the surface wherever the pointer drags it: it slides, whatever the height', () => {
    const near = stick(snapper, new THREE.Vector3(3, 0.2, -4), true, false, 0.03);
    const far = stick(snapper, new THREE.Vector3(-3, 40, 2), true, false, 0.03);

    near.point!.toArray().forEach((v, i) => expect(v).toBeCloseTo([3, 0, -4][i], 6));
    far.point!.toArray().forEach((v, i) => expect(v).toBeCloseTo([-3, 0, 2][i], 6));
    expect(near.change).toBeNull();                                     // it is stuck already
  });

  it('lets go of a stuck node when Alt is held, and moves a free one freely', () => {
    const stuck = stick(snapper, at(0.1), true, true, 0.03);
    const free = stick(snapper, at(0.1), false, true, 0.03);

    expect(stuck).toEqual({ point: null, change: 'detach' });
    expect(free).toEqual({ point: null, change: null });
  });

  it('does nothing without a surface', () => {
    expect(stick(new SurfaceSnapper(new THREE.Group()), at(0), true, false, 0.03)).toEqual({ point: null, change: null });
  });
});
