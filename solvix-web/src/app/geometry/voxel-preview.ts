import * as THREE from 'three';
import { VoxelGridDto, countOccupied, isOccupied, voxelCenter } from './voxel-grid-contract';

const VOXEL_COLOR = 0x9b59b6;
const EDGE_COLOR = 0xffffff;

// Instanced fill so a result with tens of thousands of cubes stays cheap to
// render - one draw call regardless of count, same reasoning as solid-mode
// imported-reference geometry (ordinary rasterization, not per-cube
// overhead) - plus one white LineSegments outlining every cube's 12 edges
// (a single flat position buffer, same technique as geometry/dimension-lines.ts,
// not per-instance geometry - InstancedMesh doesn't support LineSegments).
// Iterates the grid+bitmask directly (voxel-grid-contract.ts) rather than a
// materialized list of centers - two passes: count occupied cells first (to
// size the InstancedMesh exactly), then fill instance matrices.
// Built directly in WORLD space: the grid's origin is already in world
// coordinates (the mesh sent to Solvix.Api was baked from the DISPLAYED
// scaled reference's own world transform - see VoxelizationService.run /
// geometry/mesh-contract.ts's toMeshBinary), so the returned group is meant
// to be added to the scene at identity - no position/quaternion copying
// needed, unlike dimension lines/ruler (which are built in a LOCAL,
// pivot-centered frame instead).
export function buildVoxelPreview(grid: VoxelGridDto, opacity: number): THREE.Object3D {
  const group = new THREE.Group();
  const half = grid.cellSize / 2;

  const occupiedCount = countOccupied(grid);

  const geometry = new THREE.BoxGeometry(grid.cellSize, grid.cellSize, grid.cellSize);
  const material = new THREE.MeshStandardMaterial({ color: VOXEL_COLOR, transparent: true, opacity, side: THREE.DoubleSide });
  const fill = new THREE.InstancedMesh(geometry, material, occupiedCount);

  const matrix = new THREE.Matrix4();
  const edgePositions: number[] = [];
  let instanceIndex = 0;
  for (let ix = 0; ix < grid.countX; ix++) {
    for (let iy = 0; iy < grid.countY; iy++) {
      for (let iz = 0; iz < grid.countZ; iz++) {
        if (!isOccupied(grid, ix, iy, iz)) {
          continue;
        }
        const center = voxelCenter(grid, ix, iy, iz);
        matrix.makeTranslation(center.x, center.y, center.z);
        fill.setMatrixAt(instanceIndex, matrix);
        addCubeEdges(edgePositions, center, half);
        instanceIndex++;
      }
    }
  }
  fill.instanceMatrix.needsUpdate = true;
  group.add(fill);

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
  group.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: EDGE_COLOR })));

  return group;
}

// The 12 edges of one axis-aligned cube centered at `center`, appended as
// flat [x,y,z, x,y,z, ...] pairs (2 points per edge) onto `positions`.
function addCubeEdges(positions: number[], center: { x: number; y: number; z: number }, half: number): void {
  const { x, y, z } = center;
  const corners: [number, number, number][] = [
    [x - half, y - half, z - half],
    [x + half, y - half, z - half],
    [x + half, y + half, z - half],
    [x - half, y + half, z - half],
    [x - half, y - half, z + half],
    [x + half, y - half, z + half],
    [x + half, y + half, z + half],
    [x - half, y + half, z + half]
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0], // bottom face
    [4, 5], [5, 6], [6, 7], [7, 4], // top face
    [0, 4], [1, 5], [2, 6], [3, 7] // verticals
  ];
  for (const [a, b] of edges) {
    positions.push(...corners[a], ...corners[b]);
  }
}

// Mutates the fill material's opacity in place on an already-built preview
// - cheap (no geometry rebuild) so the transparency slider can update live
// without VoxelizationService needing to re-fetch anything from Solvix.Api.
// The white edge outline is deliberately NOT affected - it's meant to stay
// crisp/readable regardless of how transparent the fill is.
export function setVoxelPreviewOpacity(object: THREE.Object3D, opacity: number): void {
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh) {
      (child.material as THREE.MeshStandardMaterial).opacity = opacity;
    }
  });
}

export function disposeVoxelPreview(object: THREE.Object3D): void {
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    }
  });
}