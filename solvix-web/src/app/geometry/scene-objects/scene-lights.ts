import * as THREE from 'three';

// Lower ambient than a single strong light would need, plus a key/fill pair
// of directional lights from opposite sides (instead of one) - a single
// light + strong ambient washes out shading almost evenly across a solid
// surface, making its facets/contours hard to read. Two lights of
// different strength from different angles give every face a distinct
// brightness, so shape and silhouette actually read at a glance. A fixed
// scene fixture (not per-session/model), same lifetime as the whole
// WorldCanvasComponent, so it needs no cleanup/disposal logic of its own.
//
// The key light comes from above and a little to the side, so that the three faces of a cube seen from the usual view (top, one side, the front) are three
// clearly different tones - that is what shows the volume and the geometry of the body. The ambient light is low, so the shaded sides stay dark enough.
export function buildSceneLights(): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'scene-lights';

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.18);
  group.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(6, 10, 3);
  group.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.25);
  fillLight.position.set(-6, 3, -4);
  group.add(fillLight);

  return group;
}
