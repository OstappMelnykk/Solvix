import * as THREE from 'three';

// The lines and nodes of a body, drawn two ways with one patch of the basic shader:
//  - lifted a hair towards the camera, so the edges and nodes that lie ON the outside of a solid body win over the faces
//    they lie on (with the logarithmic depth buffer a polygon offset does nothing);
//  - faded with depth, so in a see-through body the nearer lines and nodes are strong and the farther ones dim.
// One DepthFade belongs to one view: its three uniforms are shared by every material patched with it and refreshed from
// the camera just before each patched object is drawn.

// how far a lifted fragment moves towards the camera in the (logarithmic) depth range: about 0.1 % of its distance
const LIFT = 0.00015;

export interface DepthFade {
  // Patch a basic line, point or mesh material.
  patch(material: THREE.Material): void;
  // Refresh the fade from the camera before this object is drawn.
  track(object: THREE.Object3D): void;
}

// `farAlpha` is how visible the farthest part of the body is (1 — no fade, the near-to-far range does not matter).
export function createDepthFade(centre: THREE.Vector3, radius: number, farAlpha: number): DepthFade {
  const uniforms = {
    uFadeNear: { value: 0 },
    uFadeFar: { value: 1 },
    uFadeMin: { value: farAlpha }
  };
  const inView = new THREE.Vector3();

  return {
    patch(material: THREE.Material): void {
      material.customProgramCacheKey = () => 'depth-fade';
      material.onBeforeCompile = shader => {
        shader.uniforms['uFadeNear'] = uniforms.uFadeNear;
        shader.uniforms['uFadeFar'] = uniforms.uFadeFar;
        shader.uniforms['uFadeMin'] = uniforms.uFadeMin;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying float vFadeDepth;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvFadeDepth = -mvPosition.z;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vFadeDepth;\nuniform float uFadeNear;\nuniform float uFadeFar;\nuniform float uFadeMin;')
          .replace(
            '#include <logdepthbuf_fragment>',
            `#include <logdepthbuf_fragment>\n#ifdef USE_LOGARITHMIC_DEPTH_BUFFER\ngl_FragDepth = max(0.0, gl_FragDepth - ${LIFT.toFixed(6)});\n#endif`
          )
          .replace(
            '#include <opaque_fragment>',
            '#include <opaque_fragment>\ngl_FragColor.a *= mix(1.0, uFadeMin, clamp((vFadeDepth - uFadeNear) / max(uFadeFar - uFadeNear, 0.0001), 0.0, 1.0));'
          );
      };
    },

    track(object: THREE.Object3D): void {
      object.onBeforeRender = (_renderer, _scene, camera) => {
        inView.copy(centre).applyMatrix4(camera.matrixWorldInverse);
        const depth = -inView.z;
        uniforms.uFadeNear.value = depth - radius;
        uniforms.uFadeFar.value = depth + radius;
      };
    }
  };
}
