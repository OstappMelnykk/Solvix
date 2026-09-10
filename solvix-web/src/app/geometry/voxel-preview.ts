import * as THREE from 'three';
import { VoxelGridDto } from './voxel-grid-contract';
import { buildVoxelCells } from './voxel-cell';
import { EDGES, buildVoxelHexahedronFillGeometry } from './voxel-hexahedron';

const EDGE_COLOR = 0xffffff;

// One BatchedMesh draw call for potentially tens of thousands of cubes,
// but each cube is still its OWN independent geometry (own addGeometry +
// addInstance call, own VoxelCell - see voxel-cell.ts/voxel-hexahedron.ts),
// not a shared BoxGeometry stamped out via InstancedMesh - a voxel keeps
// its own vertices/faces/neighbors as real data (buildVoxelCells), and
// this function only decides how to DRAW that data efficiently. Each
// cell's batchInstanceId is recorded so it can later be hidden/replaced
// individually (BatchedMesh.setVisibleAt/setGeometryAt) without touching
// any other cube - the seam a future per-voxel subdivision/recolor
// feature would use. The white edge outline stays a single merged
// LineSegments (same technique as geometry/dimension-lines.ts) - unlike
// the fill, there's no per-cube state worth keeping there.
// Built directly in WORLD space: the grid's origin is already in world
// coordinates (the mesh sent to Solvix.Api was baked from the DISPLAYED
// scaled reference's own world transform - see VoxelizationService.run /
// geometry/mesh-contract.ts's toMeshBinary), so the returned group is meant
// to be added to the scene at identity - no position/quaternion copying
// needed, unlike dimension lines/ruler (which are built in a LOCAL,
// pivot-centered frame instead).
export function buildVoxelPreview(grid: VoxelGridDto, fillOpacity: number, edgeOpacity: number): THREE.Object3D {
  const group = new THREE.Group();
  const cells = buildVoxelCells(grid);

  const VERTICES_PER_VOXEL = 36; // 6 faces x 2 triangles x 3 vertices - see buildVoxelHexahedronFillGeometry
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide });
  // maxIndexCount is irrelevant here (buildVoxelHexahedronFillGeometry's
  // geometries are all non-indexed) - kept at 1 rather than 0 since
  // BatchedMesh treats 0 as "use the maxVertexCount*2 default".
  const batched = new THREE.BatchedMesh(Math.max(1, cells.length), Math.max(1, cells.length * VERTICES_PER_VOXEL), 1, material);
  // See buildVoxelHexahedron's own comment - same transparent-overlap
  // z-fight fix, now applied to the shared batch instead of a per-cube mesh.
  batched.renderOrder = 1;

  const edgePositions: number[] = [];
  for (const cell of cells) {
    const fillGeometry = buildVoxelHexahedronFillGeometry(cell);
    const geometryId = batched.addGeometry(fillGeometry);
    cell.batchInstanceId = batched.addInstance(geometryId);
    // BatchedMesh copies attribute data into its own internal buffers at
    // addGeometry time - this per-cell geometry has served its purpose.
    fillGeometry.dispose();

    EDGES.forEach(([i, j]) => {
      const p0 = cell.corners[i];
      const p1 = cell.corners[j];
      edgePositions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    });
  }
  group.add(batched);

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
  group.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: edgeOpacity })));

  return group;
}

// Mutates the fill material's opacity in place on an already-built preview
// - cheap (no geometry rebuild) so the transparency slider can update live
// without VoxelizationService needing to re-fetch anything from Solvix.Api.
// Independent of the edge outline's own opacity (setVoxelEdgeOpacity) - the
// two are separate controls on purpose, since a fully-opaque wireframe
// stays readable even when the fill is turned nearly invisible, or vice
// versa.
export function setVoxelPreviewOpacity(object: THREE.Object3D, opacity: number): void {
  object.traverse(child => {
    if (child instanceof THREE.BatchedMesh) {
      (child.material as THREE.MeshStandardMaterial).opacity = opacity;
    }
  });
}

// Same live-mutation reasoning as setVoxelPreviewOpacity, for the white
// edge outline instead of the fill.
export function setVoxelEdgeOpacity(object: THREE.Object3D, opacity: number): void {
  object.traverse(child => {
    if (child instanceof THREE.LineSegments) {
      (child.material as THREE.LineBasicMaterial).opacity = opacity;
    }
  });
}

// Guards against disposing the same preview twice - BatchedMesh.dispose()
// is NOT idempotent (it nulls its own internal texture references on the
// way out, so a second call throws trying to dispose() them again, not
// just a harmless no-op like a plain BufferGeometry's dispose()). This
// matters here specifically because voxelPreview is no longer cloned per
// canvas (see world-canvas.component.ts - BatchedMesh can't support
// Object3D.clone()), so VoxelizationService's cache entry and whatever's
// in the scene can end up being the literal same object; a defense-in-depth
// safety net against any path disposing it more than once, on top of the
// actual fix (voxelPreview disposal now happens in exactly one place -
// see VoxelizationService.run/pruneTo - not also in WorldCanvasComponent).
const disposedPreviews = new WeakSet<THREE.Object3D>();

export function disposeVoxelPreview(object: THREE.Object3D): void {
  if (disposedPreviews.has(object)) {
    return;
  }
  disposedPreviews.add(object);
  object.traverse(child => {
    if (child instanceof THREE.BatchedMesh) {
      child.dispose(); // frees BatchedMesh's own internal merged geometry/textures
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    } else if (child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    }
  });
}