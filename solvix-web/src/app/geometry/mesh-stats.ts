import * as THREE from 'three';

export interface MeshStats {
  readonly meshCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
}

// Cheap structural stats across every Mesh under `object` - surfaced in
// the UI (SettingsPanelComponent's "Довідка") so a lag report can be tied
// to actual numbers instead of guessed at, same reasoning as isWatertight.
export function computeMeshStats(object: THREE.Object3D): MeshStats {
  let meshCount = 0;
  let triangleCount = 0;
  let vertexCount = 0;

  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const position = child.geometry.getAttribute('position');
    if (!position) {
      return;
    }
    meshCount++;
    vertexCount += position.count;
    const indexCount = child.geometry.index ? child.geometry.index.count : position.count;
    triangleCount += Math.floor(indexCount / 3);
  });

  return { meshCount, triangleCount, vertexCount };
}