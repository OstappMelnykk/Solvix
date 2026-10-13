import * as THREE from 'three';
import { centreIsInView } from './view-check';

describe('centreIsInView', () => {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);

  const cubeAt = (x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(x, y, z);
    mesh.updateMatrixWorld(true);
    return mesh;
  };

  it('is true for an object in the middle of the screen', () => {
    expect(centreIsInView(camera, cubeAt(0, 0, 0))).toBeTrue();
    expect(centreIsInView(camera, cubeAt(1.5, 0, 1))).toBeTrue();
  });

  it('is false for an object far to the side, behind the camera or out of the picture', () => {
    expect(centreIsInView(camera, cubeAt(40, 0, 0))).toBeFalse();
    expect(centreIsInView(camera, cubeAt(0, 0, 40))).toBeFalse();        // behind the camera
    expect(centreIsInView(camera, new THREE.Group())).toBeFalse();       // nothing to see
  });

  it('counts the edge of the screen as out, with the margin', () => {
    const near = cubeAt(5.2, 0, 0);

    expect(centreIsInView(camera, near, 1)).toBeTrue();
    expect(centreIsInView(camera, near, 0.5)).toBeFalse();
  });
});
