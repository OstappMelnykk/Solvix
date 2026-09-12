import * as THREE from 'three';
import { markForWeightedOit } from '../../rendering/weighted-oit';

// Minimal shape ImportedReferenceDisplayService's own ImportedReferenceStyle
// satisfies - kept separate (not imported from state/imported-reference-
// display.service.ts) so this geometry-layer file never depends on the
// state layer, matching how voxels.ts/zone-overlay.ts only ever take plain
// data, never a service.
export interface ImportedReferenceRenderStyle {
  readonly mode: 'solid' | 'wireframe';
  readonly color: number;
  readonly opacity: number;
}

// A visual guide for the imported STL reference, not the model being
// worked on - clones `source` and overrides its materials so it never gets
// mistaken for the actual session model rendered in the same scene.
// 'solid' is a normal LIT material (MeshStandardMaterial, DoubleSide) so
// the scene's existing lights actually shade it and it reads as a real 3D
// shape - solid triangle fill is cheap on the GPU regardless of triangle
// count (ordinary rasterization). 'wireframe' draws every triangle edge
// every frame instead - fine for a light import, but measurably tanks FPS
// well past a few hundred thousand triangles, hence this being a user
// choice (ImportedReferenceDisplayService) rather than the only option.
export function buildImportedReferenceClone(source: THREE.Object3D, style: ImportedReferenceRenderStyle | null): THREE.Object3D {
  const clone = source.clone();
  const mode = style?.mode ?? 'solid';
  const color = style?.color ?? 0xffffff;
  const opacity = style?.opacity ?? 0.5;
  // flatShading (solid mode only) - each triangle gets its own face normal
  // instead of interpolating vertex normals, so adjacent facets at
  // different angles pick up visibly different shading under the scene's
  // key/fill lights (geometry/scene-objects/scene-lights.ts). Without it,
  // curved/faceted surfaces lit this way can look like a single smooth
  // blob with no readable contours.
  const material: THREE.Material =
    mode === 'wireframe'
      ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity })
      : new THREE.MeshStandardMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, flatShading: true, roughness: 0.6 });
  if (mode === 'solid') {
    // Only the solid mode genuinely self-overlaps in a way that fights
    // with the voxel fill's own translucency (see weighted-oit.ts) -
    // wireframe's sparse lines don't meaningfully occlude each other or
    // the voxels, so they stay on the existing simple renderOrder scheme.
    markForWeightedOit(material);
  }
  clone.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.material = material;
    }
  });
  return clone;
}

export function disposeImportedReferenceClone(clone: THREE.Object3D): void {
  clone.traverse(child => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach(material => material.dispose());
  });
}
