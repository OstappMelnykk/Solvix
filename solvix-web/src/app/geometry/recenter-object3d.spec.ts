import * as THREE from 'three';
import { recenterAtOrigin } from './recenter-object3d';

function box(width: number, height: number, depth: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
}

function worldBox(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

describe('recenterAtOrigin', () => {
  it('centers an already-centered object on X/Z and grounds it at Y=0', () => {
    const mesh = box(2, 1, 3);

    recenterAtOrigin(mesh);

    const result = worldBox(mesh);
    expect(result.min.x).toBeCloseTo(-1, 5);
    expect(result.max.x).toBeCloseTo(1, 5);
    expect(result.min.y).toBeCloseTo(0, 5);
    expect(result.max.y).toBeCloseTo(1, 5);
    expect(result.min.z).toBeCloseTo(-1.5, 5);
    expect(result.max.z).toBeCloseTo(1.5, 5);
  });

  it('recenters an object authored off to one side', () => {
    const mesh = box(2, 1, 3);
    mesh.position.set(50, -20, 7);

    recenterAtOrigin(mesh);

    const result = worldBox(mesh);
    expect(result.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 5);
    expect(result.getCenter(new THREE.Vector3()).z).toBeCloseTo(0, 5);
    expect(result.min.y).toBeCloseTo(0, 5);
  });

  it('recomputes fresh rather than assuming a prior centering still holds after scaling', () => {
    const mesh = box(2, 1, 3);
    recenterAtOrigin(mesh);

    mesh.scale.setScalar(3);
    // Without reapplying, the object would drift off-center/off-floor at
    // this new scale - this is the exact regression recenterAtOrigin's own
    // doc comment warns about.
    recenterAtOrigin(mesh);

    const result = worldBox(mesh);
    expect(result.min.y).toBeCloseTo(0, 5);
    expect(result.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 5);
    expect(result.getCenter(new THREE.Vector3()).z).toBeCloseTo(0, 5);
  });

  it('re-grounds correctly after a rotation that changes which axis is vertical', () => {
    const mesh = box(2, 1, 3);
    recenterAtOrigin(mesh);

    // Rotate 90deg around Z - the original X extent (2) becomes vertical.
    mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    recenterAtOrigin(mesh);

    const result = worldBox(mesh);
    expect(result.min.y).toBeCloseTo(0, 5);
    expect(result.max.y - result.min.y).toBeCloseTo(2, 5);
  });

  it('supports a pivot Group whose local origin is not its own geometric center', () => {
    // Mirrors ImportedGeometryService.set(): the mesh's own local origin is
    // offset from its geometric center, then wrapped in a pivot.
    const mesh = box(2, 1, 3);
    mesh.position.set(-1, -0.5, -1.5); // shifts mesh's own center to local origin 0
    const pivot = new THREE.Group();
    pivot.add(mesh);

    recenterAtOrigin(pivot);

    const result = worldBox(pivot);
    expect(result.min.y).toBeCloseTo(0, 5);
    expect(result.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 5);
  });
});