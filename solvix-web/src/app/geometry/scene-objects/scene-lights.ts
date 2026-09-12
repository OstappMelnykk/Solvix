import * as THREE from 'three';

// Lower ambient than a single strong light would need, plus a key/fill pair
// of directional lights from opposite sides (instead of one) - a single
// light + strong ambient washes out shading almost evenly across a solid
// surface, making its facets/contours hard to read. Two lights of
// different strength from different angles give every face a distinct
// brightness, so shape and silhouette actually read at a glance. A fixed
// scene fixture (not per-session/model), same lifetime as the whole
// WorldCanvasComponent, so it needs no cleanup/disposal logic of its own.
export function buildSceneLights(): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'scene-lights';

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
  group.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  keyLight.position.set(5, 8, 5);
  group.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
  fillLight.position.set(-5, 2, -5);
  group.add(fillLight);

  return group;
}
