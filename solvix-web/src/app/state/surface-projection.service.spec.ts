import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { SurfaceProjectionService } from './surface-projection.service';
import { SurfaceSnapper } from '../geometry/surface-snap';

// the plane z = 0, between x, y from -5 to 5, as two triangles
function plane(): SurfaceSnapper {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, -5, 0, 5, 5, 0, -5, 5, 0], 3));
  return new SurfaceSnapper(new THREE.Mesh(geometry));
}

describe('SurfaceProjectionService', () => {
  let projection: SurfaceProjectionService;

  beforeEach(() => {
    projection = TestBed.inject(SurfaceProjectionService);
  });

  it('has no surface until a canvas hands one out, and gives nothing for any place then', () => {
    expect(projection.hasSurface()).toBeFalse();
    expect(projection.nearestPoints([new THREE.Vector3(1, 2, 3)])).toEqual([null]);
  });

  it('drops each place on the surface at the foot of the perpendicular', () => {
    const snapper = plane();
    projection.register(() => snapper);

    expect(projection.hasSurface()).toBeTrue();
    const [a, b] = projection.nearestPoints([new THREE.Vector3(1, 2, 3), new THREE.Vector3(-2, 1, -0.5)]);
    expect(a!.toArray()).toEqual([1, 2, 0]);
    expect(b!.toArray()).toEqual([-2, 1, 0]);
  });

  it('forgets a surface when its canvas goes, but not when another canvas\'s is taken back', () => {
    const snapper = plane();
    const mine = () => snapper;
    projection.register(mine);
    projection.unregister(() => null);
    expect(projection.hasSurface()).toBeTrue();

    projection.unregister(mine);
    expect(projection.hasSurface()).toBeFalse();
  });

  it('an empty surface is no surface', () => {
    projection.register(() => new SurfaceSnapper(new THREE.Group()));
    expect(projection.hasSurface()).toBeFalse();
  });
});
