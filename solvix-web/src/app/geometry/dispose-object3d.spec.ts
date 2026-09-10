import * as THREE from 'three';
import { disposeObject3D } from './dispose-object3d';

describe('disposeObject3D', () => {
  it('disposes a Mesh found in the subtree', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const geometryDispose = spyOn(mesh.geometry, 'dispose');
    const materialDispose = spyOn(mesh.material as THREE.Material, 'dispose');
    const group = new THREE.Group();
    group.add(mesh);

    disposeObject3D(group);

    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
  });

  it('disposes a LineSegments found in the subtree', () => {
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    const geometryDispose = spyOn(lines.geometry, 'dispose');
    const materialDispose = spyOn(lines.material as THREE.Material, 'dispose');
    const group = new THREE.Group();
    group.add(lines);

    disposeObject3D(group);

    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
  });

  it("disposes a BatchedMesh via its own dispose() - not just its geometry's", () => {
    const batched = new THREE.BatchedMesh(1, 3, 3, new THREE.MeshBasicMaterial());
    const batchedDispose = spyOn(batched, 'dispose').and.callThrough();
    const materialDispose = spyOn(batched.material as THREE.Material, 'dispose');
    const group = new THREE.Group();
    group.add(batched);

    disposeObject3D(group);

    expect(batchedDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
  });

  it('disposes every material in a multi-material array', () => {
    const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), materials);
    const disposeSpies = materials.map(material => spyOn(material, 'dispose'));

    disposeObject3D(mesh);

    disposeSpies.forEach(spy => expect(spy).toHaveBeenCalled());
  });

  it('does nothing for an object with no disposable descendants', () => {
    expect(() => disposeObject3D(new THREE.Group())).not.toThrow();
  });
});