import * as THREE from 'three';
import { VoxelGridDto } from './voxel-grid-contract';
import { buildVoxelCells, collectUniqueNodes } from './voxel-cell';
import { EDGES, buildVoxelHexahedronFillGeometry } from './voxel-hexahedron';

const EDGE_COLOR = 0xffffff;
// Distinct from both the purple fill and the white edges, so a node stays
// visible sitting right on top of a face/edge - the whole point of
// rendering these is to make the SHARED, deduplicated nodes (voxel-cell.ts's
// collectUniqueNodes) visually verifiable: one sphere per unique lattice
// point, never one per (cell, corner) pair, no matter how many cells
// touch it.
const NODE_COLOR = 0xffaa00;
// nodeSize is a [0,1] slider value (same convention as fillOpacity/
// edgeOpacity) - this is the radius a node gets, relative to cellSize, at
// nodeSize=1. A tiny floor keeps the geometry non-degenerate at nodeSize=0
// rather than an exactly-zero-radius sphere.
const NODE_RADIUS_MAX_FACTOR = 0.12;
const MIN_NODE_RADIUS = 0.001;

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
export function buildVoxelPreview(grid: VoxelGridDto, fillOpacity: number, edgeOpacity: number, nodeSize: number, nodeOpacity: number): THREE.Object3D {
  const group = new THREE.Group();
  // Node size is expressed relative to cellSize (see NODE_RADIUS_MAX_FACTOR),
  // so setVoxelNodeSize needs cellSize back later to recompute an absolute
  // radius - stashed here rather than threaded through as an extra
  // parameter, keeping that setter's signature symmetric with
  // setVoxelPreviewOpacity/setVoxelEdgeOpacity (object, value).
  group.userData['cellSize'] = grid.cellSize;
  const cells = buildVoxelCells(grid);

  const VERTICES_PER_VOXEL = 36; // 6 faces x 2 triangles x 3 vertices - see buildVoxelHexahedronFillGeometry
  // depthWrite off: with it on, even a near-invisible (low-opacity) cube
  // still writes the depth buffer wherever it's drawn, so it can block
  // whatever's meant to be seen through it (the imported mesh, or other
  // cubes) at that pixel regardless of how transparent it looks - worse,
  // WHICH overlapping cube face "wins" that write depends on draw order
  // (BatchedMesh's own back-to-front sort, keyed off each instance's
  // distance to the camera), which can flip unpredictably at some camera
  // angles, reading as cubes suddenly turning into an opaque wall. With
  // it off, every cube's color blends purely by alpha regardless of draw
  // order - the tradeoff (documented on the pre-BatchedMesh version of
  // this file) is that deeply overlapping translucent faces can drift in
  // apparent color instead of cleanly occluding each other, but seeing
  // through the fill is this control's entire purpose.
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: fillOpacity,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  // maxIndexCount is irrelevant here (buildVoxelHexahedronFillGeometry's
  // geometries are all non-indexed) - kept at 1 rather than 0 since
  // BatchedMesh treats 0 as "use the maxVertexCount*2 default".
  const batched = new THREE.BatchedMesh(Math.max(1, cells.length), Math.max(1, cells.length * VERTICES_PER_VOXEL), 1, material);
  // See buildVoxelHexahedron's own comment - same transparent-overlap
  // z-fight fix, now applied to the shared batch instead of a per-cube mesh.
  batched.renderOrder = 1;
  // BatchedMesh's default per-instance frustum culling computes each
  // cube's bounding sphere from a shared internal buffer and re-evaluates
  // it against the camera every frame - at some camera angles this was
  // dropping cubes that were genuinely still on screen (an unstable,
  // angle-dependent "some cubes just don't render" glitch, not a
  // transparency/depth issue). Our counts are capped low enough
  // (MaxCells = 900_000, realistically far fewer for interactive use)
  // that always submitting every instance costs little, and correctness
  // here matters more than the CPU-side skip.
  batched.perObjectFrustumCulled = false;

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

  // One sphere per UNIQUE node (collectUniqueNodes - shared corners
  // between adjacent voxels collapse to a single sphere, not one per
  // cell that touches them), instanced for the same reason the fill is
  // batched: a real grid can have tens of thousands of nodes.
  const nodes = collectUniqueNodes(cells);
  const nodeRadius = Math.max(MIN_NODE_RADIUS, grid.cellSize * NODE_RADIUS_MAX_FACTOR * nodeSize);
  const nodeGeometry = new THREE.SphereGeometry(nodeRadius, 8, 6);
  const nodeMesh = new THREE.InstancedMesh(
    nodeGeometry,
    new THREE.MeshBasicMaterial({ color: NODE_COLOR, transparent: true, opacity: nodeOpacity }),
    nodes.length
  );
  const nodeMatrix = new THREE.Matrix4();
  nodes.forEach((node, index) => {
    nodeMatrix.makeTranslation(node.x, node.y, node.z);
    nodeMesh.setMatrixAt(index, nodeMatrix);
  });
  nodeMesh.instanceMatrix.needsUpdate = true;
  nodeMesh.renderOrder = 2; // draw after the fill (renderOrder 1) so a node sitting on a face never z-fights it away
  group.add(nodeMesh);

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

// Same live-mutation reasoning as setVoxelPreviewOpacity/setVoxelEdgeOpacity,
// for the node spheres.
export function setVoxelNodeOpacity(object: THREE.Object3D, opacity: number): void {
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh) {
      (child.material as THREE.MeshBasicMaterial).opacity = opacity;
    }
  });
}

// Unlike the opacity setters above, this DOES rebuild geometry - a
// sphere's radius isn't a material property that can be mutated in place.
// Still cheap: one shared SphereGeometry for every instance (InstancedMesh),
// not one per node, so this is a single small geometry swap regardless of
// how many nodes exist.
export function setVoxelNodeSize(object: THREE.Object3D, size: number): void {
  const cellSize = (object.userData['cellSize'] as number | undefined) ?? 1;
  const radius = Math.max(MIN_NODE_RADIUS, cellSize * NODE_RADIUS_MAX_FACTOR * size);
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh) {
      const oldGeometry = child.geometry;
      child.geometry = new THREE.SphereGeometry(radius, 8, 6);
      oldGeometry.dispose();
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
    } else if (child instanceof THREE.LineSegments || child instanceof THREE.InstancedMesh) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    }
  });
}