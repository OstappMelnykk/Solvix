import * as THREE from 'three';
import { darkenZoneColorHex } from './zone-overlay';
import { markForWeightedOit } from '../../rendering/weighted-oit';

// Minimal shape SurfaceZonePaintingService's own zone list satisfies - kept
// separate from state/surface-zone-painting.service.ts for the same reason
// zone-overlay.ts's own ZoneOverlayZone is: this geometry-layer file never
// depends on the state layer.
export interface SurfaceZoneOverlayZone {
  readonly voxelZoneId: number;
  readonly color: string;
}

const FALLBACK_COLOR = 0x808080; // a triangle assignTriangleZones somehow left unassigned - shouldn't happen once save() has actually succeeded (full coverage is a precondition), shown neutral gray rather than silently invisible if it ever does.

// A colored clone of `stlMesh`, one vertex color baked per triangle from
// `triangleZone` (SurfaceZonePaintingService.zoneIdOfTriangle's own data -
// same per-triangle indexing geometry/surface-shell-grid.ts's
// assignTriangleZones produces, walking `stlMesh` the exact same way this
// does). Shown only in the "3D результат" panel once painting is saved -
// same "hidden except during that one panel's own render()" idiom
// ZonePaintingComponent's own voxel zone-overlay group already uses.
//
// Always de-indexes the geometry first (BufferGeometry.toNonIndexed() - a
// safe no-op if it's already non-indexed, which three.js's STLLoader output
// always is anyway): a plain per-VERTEX color on an INDEXED geometry would
// incorrectly blend across every triangle sharing that vertex, rather than
// each triangle keeping its own solid zone color.
export function buildSurfaceZoneOverlay(
  stlMesh: THREE.Object3D,
  triangleZone: Int16Array,
  zones: readonly SurfaceZoneOverlayZone[],
  opacity: number
): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'surface-zone-overlay';
  const colorByZoneId = new Map<number, THREE.Color>();
  for (const zone of zones) {
    colorByZoneId.set(zone.voxelZoneId, new THREE.Color(darkenZoneColorHex(zone.color)));
  }
  const fallback = new THREE.Color(FALLBACK_COLOR);

  let triangleIndex = 0;
  stlMesh.traverse(child => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const position = child.geometry.getAttribute('position');
    if (!position) {
      return;
    }
    const nonIndexed = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    const cornerCount = nonIndexed.getAttribute('position').count;
    const colors = new Float32Array(cornerCount * 3);
    for (let corner = 0; corner < cornerCount; corner += 3) {
      const zoneId = triangleZone[triangleIndex] ?? -1;
      const color = zoneId === -1 ? fallback : colorByZoneId.get(zoneId) ?? fallback;
      for (let vertex = 0; vertex < 3; vertex++) {
        colors[(corner + vertex) * 3] = color.r;
        colors[(corner + vertex) * 3 + 1] = color.g;
        colors[(corner + vertex) * 3 + 2] = color.b;
      }
      triangleIndex++;
    }
    nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity, side: THREE.DoubleSide });
    // Self-overlaps the STL reference it's drawn on top of (same pixel,
    // opaque-ish colored surface vs. the reference's own translucent
    // shading) - tagged for the same stable-transparency pipeline the STL
    // reference and voxel fill already use (rendering/weighted-oit.ts).
    markForWeightedOit(material);
    const mesh = new THREE.Mesh(nonIndexed, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(child.matrixWorld);
    group.add(mesh);
  });

  return group;
}

export function setSurfaceZoneOverlayOpacity(group: THREE.Object3D, opacity: number): void {
  group.traverse(child => {
    if (child instanceof THREE.Mesh) {
      (child.material as THREE.MeshStandardMaterial).opacity = opacity;
    }
  });
}

export function disposeSurfaceZoneOverlay(group: THREE.Object3D): void {
  group.removeFromParent();
  group.traverse(child => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    child.geometry.dispose();
    (child.material as THREE.Material).dispose();
  });
}
