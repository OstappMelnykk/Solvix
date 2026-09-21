import * as THREE from 'three';
import { VoxelGridDto, isOccupied, voxelCenter } from '../voxel-grid-contract';

// A plain, unlit, single-color box per occupied cell - the base layer for
// ZonePreviewComponent's own small, read-only 3D preview panel. Deliberately
// NOT the shared, vertex-colored, click-to-select buildVoxelPreview
// (voxels.ts): that one is built for interactive editing (raycasting,
// per-voxel highlight, edge/node overlays) in the main World view, while
// this preview is passive - no picking, no highlight - and the user
// explicitly asked for a plain white base here, distinct from the main
// view's own color scheme.
export function buildVoxelBasePreview(grid: VoxelGridDto, color = 0xffffff): THREE.InstancedMesh | null {
  const positions: { x: number; y: number; z: number }[] = [];
  for (let iz = 0; iz < grid.countZ; iz++) {
    for (let iy = 0; iy < grid.countY; iy++) {
      for (let ix = 0; ix < grid.countX; ix++) {
        if (isOccupied(grid, ix, iy, iz)) {
          positions.push(voxelCenter(grid, ix, iy, iz));
        }
      }
    }
  }
  if (positions.length === 0) {
    return null;
  }

  const geometry = new THREE.BoxGeometry(grid.cellSize, grid.cellSize, grid.cellSize);
  const material = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  const matrix = new THREE.Matrix4();
  positions.forEach((position, i) => {
    matrix.setPosition(position.x, position.y, position.z);
    mesh.setMatrixAt(i, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

export function disposeVoxelBasePreview(mesh: THREE.InstancedMesh): void {
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
}
