import * as THREE from 'three';
import { VoxelGridDto, isOccupied, voxelCenter } from './voxel-grid-contract';

// Minimal shape ZonePaintingService's own ZoneDefinition satisfies - kept
// separate (not imported from state/zone-painting.service.ts) so this
// geometry-layer file never depends on the state layer, matching how
// voxel-preview.ts/voxel-cell.ts only ever take plain data (VoxelGridDto),
// never a service.
export interface ZoneOverlayZone {
  readonly id: number;
  readonly color: string;
}

// ZONED_DARKEN_FACTOR/ZONED_ALPHA are for the 2D 'zoned' cell fill on the 3
// flat painting panels only (darkenZoneColorCss) - fixed, since that's a
// small interaction cue, not a "see the model through it" viewing surface.
// The two full-3D views (the zone-painting window's own result panel, and
// WorldCanvasComponent's "Показати зони" button) instead take an explicit,
// user-adjustable `opacity` (ZonePaintingService.getZoneOverlayOpacity) so
// the user can turn zone colors down to see the underlying model's detail
// through them - see buildZoneOverlayGroup/setZoneOverlayOpacity below.
export const ZONED_DARKEN_FACTOR = 0.6;
export const ZONED_ALPHA = 0.75;

function darkenComponents(hexColor: string): { r: number; g: number; b: number } {
  const value = parseInt(hexColor.slice(1), 16);
  return {
    r: Math.round(((value >> 16) & 0xff) * ZONED_DARKEN_FACTOR),
    g: Math.round(((value >> 8) & 0xff) * ZONED_DARKEN_FACTOR),
    b: Math.round((value & 0xff) * ZONED_DARKEN_FACTOR)
  };
}

// For a canvas 2D `fillStyle` - includes ZONED_ALPHA as a CSS rgba() alpha.
export function darkenZoneColorCss(hexColor: string): string {
  const { r, g, b } = darkenComponents(hexColor);
  return `rgba(${r}, ${g}, ${b}, ${ZONED_ALPHA})`;
}

// For THREE.Color.set()/MeshBasicMaterial's `color` - a THREE.Color has no
// alpha channel of its own (the mesh's material.opacity carries ZONED_ALPHA
// instead, applied by buildZoneOverlayGroup below).
export function darkenZoneColorHex(hexColor: string): string {
  const { r, g, b } = darkenComponents(hexColor);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Builds ONE InstancedMesh PER ZONE (not one shared mesh with a per-instance
// color - InstancedMesh.setColorAt rendered black/near-black in practice).
// Each zone's mesh gets a plain `material.color` set directly in the
// constructor, the same pattern voxel-preview.ts's own edges/nodes/
// highlight overlays already use successfully (EDGE_COLOR/NODE_COLOR/
// HIGHLIGHT_COLOR). Returns null when there's nothing zoned yet - the
// caller should simply not add anything to its scene in that case.
export function buildZoneOverlayGroup(
  grid: VoxelGridDto,
  zones: readonly ZoneOverlayZone[],
  zoneIdAt: (ix: number, iy: number, iz: number) => number | null,
  opacity: number
): THREE.Group | null {
  const positionsByZone = new Map<number, { x: number; y: number; z: number }[]>();
  for (let iz = 0; iz < grid.countZ; iz++) {
    for (let iy = 0; iy < grid.countY; iy++) {
      for (let ix = 0; ix < grid.countX; ix++) {
        if (!isOccupied(grid, ix, iy, iz)) {
          continue;
        }
        const zoneId = zoneIdAt(ix, iy, iz);
        if (zoneId === null) {
          continue;
        }
        const list = positionsByZone.get(zoneId) ?? [];
        list.push(voxelCenter(grid, ix, iy, iz));
        positionsByZone.set(zoneId, list);
      }
    }
  }
  if (positionsByZone.size === 0) {
    return null;
  }

  const group = new THREE.Group();
  group.name = 'zone-overlay';
  // Slightly larger than the real voxel cube so it wins the depth test
  // outright instead of z-fighting with the identically-sized cube
  // underneath - shared across every zone's mesh (one geometry, many
  // materials).
  const geometry = new THREE.BoxGeometry(grid.cellSize * 1.02, grid.cellSize * 1.02, grid.cellSize * 1.02);
  const matrix = new THREE.Matrix4();

  for (const [zoneId, positions] of positionsByZone) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) {
      continue;
    }
    // depthWrite:false - a translucent overlay shouldn't write its own
    // depth into the buffer: the scene already has 2 other translucent
    // layers (the STL reference and the voxel fill itself), whose
    // back-to-front sort order is fragile enough across camera angles
    // without a 3rd translucent layer's depth values interfering with it
    // too. This doesn't fix that older, larger, known limitation (real
    // order-independent transparency would) - it just keeps this NEW layer
    // from making it worse.
    const material = new THREE.MeshBasicMaterial({ color: darkenZoneColorHex(zone.color), transparent: true, opacity, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
    positions.forEach((position, i) => {
      matrix.setPosition(position.x, position.y, position.z);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Explicit renderOrder, same discipline voxel-preview.ts's own
    // buildVoxelPreview already uses to keep its several translucent layers
    // stable across camera angles (fill=1, edges/nodes=2, highlight=3) -
    // without one, this mesh fell back to three.js's default per-object
    // distance sort, which is exactly what made it flip/flicker while
    // orbiting. Drawn last (after all of those).
    mesh.renderOrder = 4;
    group.add(mesh);
  }

  return group;
}

// Updates every zone mesh's opacity in place - what a live slider drag
// calls (both ZonePaintingComponent's 3D result panel and
// WorldCanvasComponent's "Показати зони" button), since re-running
// buildZoneOverlayGroup's full voxel scan on every input event would be
// wasteful when only the material opacity actually changed.
export function setZoneOverlayOpacity(group: THREE.Group, opacity: number): void {
  group.children.forEach(child => {
    if (child instanceof THREE.InstancedMesh) {
      (child.material as THREE.MeshBasicMaterial).opacity = opacity;
    }
  });
}

export function disposeZoneOverlayGroup(group: THREE.Group): void {
  group.removeFromParent();
  // Every child InstancedMesh shares the SAME geometry instance (built once
  // in buildZoneOverlayGroup) - dispose it once, not once per zone.
  const sharedGeometry = (group.children[0] as THREE.InstancedMesh | undefined)?.geometry;
  sharedGeometry?.dispose();
  group.children.forEach(child => {
    if (child instanceof THREE.InstancedMesh) {
      (child.material as THREE.Material).dispose();
    }
  });
}