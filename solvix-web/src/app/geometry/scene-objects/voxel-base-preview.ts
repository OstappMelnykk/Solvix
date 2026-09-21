import * as THREE from 'three';
import { VoxelGridDto } from '../voxel-grid-contract';
import { buildVoxelCells } from '../voxel-cell';
import { EDGES, buildVoxelHexahedronFillGeometry } from '../voxel-hexahedron';

// The base layer for ZonePreviewComponent's own small, read-only 3D preview
// panel - same fill+edge TECHNIQUE (hexahedron fill geometry, cylinder edge
// instances) as the shared, interactive buildVoxelPreview (voxels.ts) uses
// for the real editing views, so this preview reads as "the same voxels,
// just white" rather than a visibly different, flatter placeholder. Left
// out on purpose, unlike buildVoxelPreview: per-instance cell tracking (no
// raycasting/click-to-select here), node spheres and the click highlight
// mesh (nothing to highlight in a passive preview).
const EDGE_RADIUS_FACTOR = 0.02;

export function buildVoxelBasePreview(grid: VoxelGridDto, fillColor: THREE.ColorRepresentation = 0xffffff, edgeColor: THREE.ColorRepresentation = 0xffffff): THREE.Group | null {
  const cells = buildVoxelCells(grid);
  if (cells.length === 0) {
    return null;
  }

  const group = new THREE.Group();

  // --- Fill ----------------------------------------------------------------
  const VERTICES_PER_VOXEL = 36; // 6 faces x 2 triangles x 3 vertices - matches buildVoxelHexahedronFillGeometry
  const fillMaterial = new THREE.MeshStandardMaterial({ vertexColors: true });
  const batched = new THREE.BatchedMesh(cells.length, cells.length * VERTICES_PER_VOXEL, 1, fillMaterial);
  batched.perObjectFrustumCulled = false;
  for (const cell of cells) {
    const fillGeometry = buildVoxelHexahedronFillGeometry(cell, { fillColor });
    const geometryId = batched.addGeometry(fillGeometry);
    batched.addInstance(geometryId);
    fillGeometry.dispose();
  }
  group.add(batched);

  // --- Edges -----------------------------------------------------------------
  const edgeGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
  const edgeRadius = Math.max(0.001, grid.cellSize * EDGE_RADIUS_FACTOR);
  const edgeMesh = new THREE.InstancedMesh(edgeGeometry, new THREE.MeshBasicMaterial({ color: edgeColor }), cells.length * EDGES.length);
  const edgeMatrix = new THREE.Matrix4();
  const edgeQuaternion = new THREE.Quaternion();
  const edgeScale = new THREE.Vector3();
  const edgeMidpoint = new THREE.Vector3();
  const edgeDirection = new THREE.Vector3();
  const CYLINDER_UP = new THREE.Vector3(0, 1, 0);
  let edgeInstanceIndex = 0;
  for (const cell of cells) {
    EDGES.forEach(([i, j]) => {
      const p0 = cell.corners[i];
      const p1 = cell.corners[j];
      edgeMidpoint.set((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2);
      edgeDirection.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
      const length = edgeDirection.length();
      edgeDirection.normalize();
      edgeQuaternion.setFromUnitVectors(CYLINDER_UP, edgeDirection);
      edgeScale.set(edgeRadius, length, edgeRadius);
      edgeMatrix.compose(edgeMidpoint, edgeQuaternion, edgeScale);
      edgeMesh.setMatrixAt(edgeInstanceIndex, edgeMatrix);
      edgeInstanceIndex++;
    });
  }
  edgeMesh.instanceMatrix.needsUpdate = true;
  group.add(edgeMesh);

  return group;
}

export function disposeVoxelBasePreview(group: THREE.Group): void {
  group.traverse(child => {
    if (child instanceof THREE.BatchedMesh || child instanceof THREE.InstancedMesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  });
}

