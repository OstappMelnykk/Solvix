import * as THREE from 'three';
import { VoxelGridDto } from '../voxel-grid-contract';
import { VoxelCell, buildVoxelCells, collectUniqueNodes } from '../voxel-cell';
import { EDGES, buildVoxelHexahedronFillGeometry } from '../voxel-hexahedron';
import { disposeObject3D } from '../dispose-object3d';
import { markForWeightedOit } from '../../rendering/weighted-oit';

// Everything about the voxel preview - the cube fill, the edge wireframe,
// the node spheres, and the click-to-select highlight - lives in this ONE
// file: they're always built together (buildVoxelPreview), always
// disposed together, and every external caller (VoxelizationService,
// WorldCanvasComponent, ZonePaintingComponent) treats the result as a
// single opaque `THREE.Object3D` handle, never as 4 separate pieces. Other
// scene objects (the STL reference, the floor grid, the axes helper, the
// lights, the colored-zone overlay) are each a genuinely separate feature
// with their own build/dispose lifecycle, which is why THEY get their own
// files under this same geometry/scene-objects/ folder instead.

const EDGE_COLOR = 0xffffff;
// Real 3D tubes (InstancedMesh of a unit CylinderGeometry, one instance per
// edge - see buildVoxelEdges below), not screen-space "fat lines" (three's
// LineSegments2/LineMaterial addon) - that was tried first and reverted:
// its quad-extrusion shader draws in screen space using a `resolution`
// uniform this module has no renderer to supply on its own, and in
// practice read as detached from the actual edges (visibly shifted,
// sometimes not depth-resolving correctly against the fill/nodes, flat
// rather than tube-shaped). A real cylinder participates in the ordinary
// depth buffer exactly like the fill and node spheres already do.
// CylinderGeometry's own default radialSegments (32) - previously lowered
// to 6 to cut per-instance vertex count (edges aren't deduplicated between
// face-adjacent cells, so a large grid can still mean millions of
// instances) - reset to the plain default per explicit request.
const EDGE_RADIAL_SEGMENTS = 32;
// edgeWidth is a [0,1] slider value (same convention as fillOpacity/
// nodeSize) - this is the cylinder's radius, relative to cellSize, at
// edgeWidth=1. Kept deliberately thinner than a node at its own max
// (NODE_RADIUS_MAX_FACTOR) so the edges read as a wireframe accent, not a
// second layer of nodes. A tiny floor keeps the geometry non-degenerate at
// edgeWidth=0, same reasoning as MIN_NODE_RADIUS below.
const EDGE_RADIUS_MAX_FACTOR = 0.025;
const MIN_EDGE_RADIUS = 0.001;
// Distinguishes the edge/node InstancedMeshes from each other (and from any
// other THREE.InstancedMesh a future feature might add to this same group)
// when traversing - see setVoxelEdgeOpacity/setVoxelLineWidth vs.
// setVoxelNodeOpacity/setVoxelNodeSize below. Same idiom as
// VOXEL_HIGHLIGHT_NAME.
const VOXEL_EDGE_NAME = 'voxel-edges';
const VOXEL_NODE_NAME = 'voxel-nodes';
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

// Click-to-select highlight (setVoxelHighlight) - a single reusable overlay
// mesh per preview, repositioned/rescaled onto whichever cell is currently
// selected rather than rebuilt per click. Found later by `.name`, not by
// `instanceof THREE.Mesh` alone - BatchedMesh (the fill) IS a THREE.Mesh
// subclass, so type-checking alone can't tell the two apart.
const VOXEL_HIGHLIGHT_NAME = 'voxel-highlight';
const HIGHLIGHT_COLOR = 0xff0000;
const HIGHLIGHT_OPACITY = 0.55;
// Slightly larger than the cube itself so the red overlay's faces don't
// z-fight the fill's own faces sitting at the exact same position.
const HIGHLIGHT_OVERSCALE = 1.03;

const VERTICES_PER_VOXEL = 36; // 6 faces x 2 triangles x 3 vertices - see buildVoxelHexahedronFillGeometry

// Per-cell lookup for click-to-select, keyed by the preview object's own
// identity so it needs no explicit disposal - it's freed the moment the
// preview itself is garbage-collected, same idiom as `disposedPreviews`
// below.
const cellByInstanceIdByPreview = new WeakMap<THREE.Object3D, ReadonlyMap<number, VoxelCell>>();

// The cell a raycast hit resolves to, given the BatchedMesh instanceId
// (`Intersection.batchId`, identical to VoxelCell.batchInstanceId - see
// buildVoxelPreview) three.js's own raycast() reports. Null for a preview
// that was never registered (shouldn't happen - every buildVoxelPreview
// call registers one) or an instanceId with no matching cell.
export function getVoxelCellByInstanceId(preview: THREE.Object3D, instanceId: number): VoxelCell | null {
  return cellByInstanceIdByPreview.get(preview)?.get(instanceId) ?? null;
}

// Built directly in WORLD space: the grid's origin is already in world
// coordinates (the mesh sent to Solvix.Api was baked from the DISPLAYED
// scaled reference's own world transform - see VoxelizationService.run /
// geometry/mesh-contract.ts's toMeshBinary), so the returned group is meant
// to be added to the scene at identity - no position/quaternion copying
// needed, unlike dimension lines/ruler (which are built in a LOCAL,
// pivot-centered frame instead).
export function buildVoxelPreview(
  grid: VoxelGridDto,
  fillOpacity: number,
  edgeOpacity: number,
  lineWidth: number,
  nodeSize: number,
  nodeOpacity: number
): THREE.Object3D {
  const group = new THREE.Group();
  const cells = buildVoxelCells(grid);

  // --- Fill (the cube faces) ---------------------------------------------
  // One BatchedMesh draw call for potentially tens of thousands of cubes,
  // but each cube is still its OWN independent geometry (own addGeometry +
  // addInstance call, own VoxelCell - see voxel-cell.ts/voxel-hexahedron.ts),
  // not a shared BoxGeometry stamped out via InstancedMesh - a voxel keeps
  // its own vertices/faces/neighbors as real data (buildVoxelCells), and
  // this only decides how to DRAW that data efficiently. Each cell's
  // batchInstanceId is recorded so it can later be hidden/replaced
  // individually (BatchedMesh.setVisibleAt/setGeometryAt) without touching
  // any other cube - the seam a future per-voxel subdivision/recolor
  // feature would use.
  // material/geometry settings (side, depthWrite, renderOrder) reset to
  // THREE.js's own plain defaults per explicit request - side defaults to
  // THREE.FrontSide, depthWrite defaults to true, renderOrder defaults to
  // 0. Earlier iterations had these tuned away from default specifically
  // to fix real visual bugs (translucent cubes blocking what's behind them
  // inconsistently across camera angles, z-fighting between the fill and
  // the edges/nodes/highlight drawn on top of it) - resetting them can
  // bring those symptoms back.
  const fillMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: fillOpacity
  });
  // Self-overlaps heavily (every internal shared face between adjacent
  // solid voxels is drawn - see VERTICES_PER_VOXEL's comment above) and is
  // frequently translucent alongside the STL reference - exactly the case
  // weighted-oit.ts exists for.
  markForWeightedOit(fillMaterial);
  // maxIndexCount is irrelevant here (buildVoxelHexahedronFillGeometry's
  // geometries are all non-indexed) - kept at 1 rather than 0 since
  // BatchedMesh treats 0 as "use the maxVertexCount*2 default".
  const batched = new THREE.BatchedMesh(Math.max(1, cells.length), Math.max(1, cells.length * VERTICES_PER_VOXEL), 1, fillMaterial);
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

  const cellByInstanceId = new Map<number, VoxelCell>();
  for (const cell of cells) {
    const fillGeometry = buildVoxelHexahedronFillGeometry(cell);
    const geometryId = batched.addGeometry(fillGeometry);
    cell.batchInstanceId = batched.addInstance(geometryId);
    cellByInstanceId.set(cell.batchInstanceId, cell);
    // BatchedMesh copies attribute data into its own internal buffers at
    // addGeometry time - this per-cell geometry has served its purpose.
    fillGeometry.dispose();
  }
  group.add(batched);
  cellByInstanceIdByPreview.set(group, cellByInstanceId);

  // --- Edges (the wireframe tubes) ----------------------------------------
  // One shared unit cylinder (radius 1, height 1, centered on the origin,
  // aligned along local +Y - CylinderGeometry's own default), scaled/
  // rotated/translated per instance below - same "one shared geometry,
  // many instances" reasoning as the node spheres.
  const edgeGeometry = new THREE.CylinderGeometry(1, 1, 1, EDGE_RADIAL_SEGMENTS);
  const edgeRadius = Math.max(MIN_EDGE_RADIUS, grid.cellSize * EDGE_RADIUS_MAX_FACTOR * lineWidth);
  const edgeMesh = new THREE.InstancedMesh(
    edgeGeometry,
    new THREE.MeshBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: edgeOpacity }),
    cells.length * EDGES.length
  );
  edgeMesh.name = VOXEL_EDGE_NAME;
  // Scratch objects reused across every instance below (cells.length * 12
  // of them for a real grid) rather than allocated per-edge - same
  // reasoning as nodeMatrix below, just with more moving parts since an
  // edge also needs a rotation (aligning the unit cylinder's +Y to the
  // edge's own direction) and a non-uniform scale (radius on X/Z, the
  // edge's actual length on Y), not just a translation.
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

  // --- Nodes (the shared lattice-point spheres) ---------------------------
  // One sphere per UNIQUE node (collectUniqueNodes - shared corners
  // between adjacent voxels collapse to a single sphere, not one per
  // cell that touches them), instanced for the same reason the fill is
  // batched: a real grid can have tens of thousands of nodes.
  const nodes = collectUniqueNodes(cells);
  const nodeRadius = Math.max(MIN_NODE_RADIUS, grid.cellSize * NODE_RADIUS_MAX_FACTOR * nodeSize);
  const nodeGeometry = new THREE.SphereGeometry(nodeRadius);
  const nodeMesh = new THREE.InstancedMesh(
    nodeGeometry,
    new THREE.MeshBasicMaterial({ color: NODE_COLOR, transparent: true, opacity: nodeOpacity }),
    nodes.length
  );
  nodeMesh.name = VOXEL_NODE_NAME;
  const nodeMatrix = new THREE.Matrix4();
  nodes.forEach((node, index) => {
    nodeMatrix.makeTranslation(node.x, node.y, node.z);
    nodeMesh.setMatrixAt(index, nodeMatrix);
  });
  nodeMesh.instanceMatrix.needsUpdate = true;
  group.add(nodeMesh);

  // --- Highlight (single reusable click-to-select overlay) ----------------
  // Hidden until setVoxelHighlight actually selects a cell - see that
  // function. A unit box: setVoxelHighlight scales it to whichever cell's
  // size it's currently standing in for, rather than this rebuilding
  // geometry per click.
  const highlightMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR, transparent: true, opacity: HIGHLIGHT_OPACITY })
  );
  highlightMesh.name = VOXEL_HIGHLIGHT_NAME;
  highlightMesh.visible = false;
  group.add(highlightMesh);

  return group;
}

// Moves the single reusable highlight overlay onto `cell` and shows it, or
// hides it when `cell` is null (clicked empty space, or nothing found for
// the raycast's instanceId - see VoxelizationService.selectVoxelInstance).
// Cheap regardless of how many cells exist: repositions/rescales one mesh,
// never rebuilds geometry.
export function setVoxelHighlight(preview: THREE.Object3D, cell: VoxelCell | null): void {
  const highlight = preview.children.find(
    (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === VOXEL_HIGHLIGHT_NAME
  );
  if (!highlight) {
    return;
  }
  if (!cell || cell.batchInstanceId === null) {
    highlight.visible = false;
    selectedInstanceIdByPreview.delete(preview);
    return;
  }
  const box = new THREE.Box3().setFromPoints([...cell.corners]);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(HIGHLIGHT_OVERSCALE);
  highlight.position.copy(center);
  highlight.scale.copy(size);
  highlight.visible = true;
  selectedInstanceIdByPreview.set(preview, cell.batchInstanceId);
}

// Which cell setVoxelHighlight last selected on this preview, if any - the
// "press Delete to remove the selected voxel" feature
// (VoxelizationService.removeSelectedVoxel) needs to know this without a
// separate, easy-to-desync "current selection" store of its own. Keyed by
// the preview object's own identity (same idiom as
// cellByInstanceIdByPreview above) so a rebuilt/replaced preview starts
// with no selection automatically - exactly matching the highlight mesh's
// own visible=false default on a fresh build, rather than needing to be
// cleared by hand every place a preview gets replaced.
const selectedInstanceIdByPreview = new WeakMap<THREE.Object3D, number>();

export function getSelectedVoxelCell(preview: THREE.Object3D): VoxelCell | null {
  const instanceId = selectedInstanceIdByPreview.get(preview);
  return instanceId === undefined ? null : getVoxelCellByInstanceId(preview, instanceId);
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
// edge tubes instead of the fill. Filtered by name, not just
// `instanceof THREE.InstancedMesh` - the node spheres are ALSO an
// InstancedMesh sitting in the same group (see setVoxelNodeOpacity below),
// so type-checking alone can't tell the two apart.
export function setVoxelEdgeOpacity(object: THREE.Object3D, opacity: number): void {
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh && child.name === VOXEL_EDGE_NAME) {
      (child.material as THREE.MeshBasicMaterial).opacity = opacity;
    }
  });
}

// Unlike the opacity setters, this can't just mutate a material property -
// the radius is baked into each instance's own transform matrix (scale.x/z),
// alongside that edge's length (scale.y) and orientation (its rotation),
// neither of which this should touch. Decomposes each instance's existing
// matrix, replaces only the radius component, and recomposes it, rather
// than rebuilding geometry (a cylinder's radius, unlike a sphere's -
// setVoxelNodeSize below - can't be a single shared geometry parameter
// here anyway, since world-space edge LENGTH already varies the scale.y
// component per instance). Takes cellSize explicitly, same reasoning as
// setVoxelNodeSize's own doc comment.
export function setVoxelLineWidth(object: THREE.Object3D, width: number, cellSize: number): void {
  const radius = Math.max(MIN_EDGE_RADIUS, cellSize * EDGE_RADIUS_MAX_FACTOR * width);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  object.traverse(child => {
    if (!(child instanceof THREE.InstancedMesh) || child.name !== VOXEL_EDGE_NAME) {
      return;
    }
    for (let i = 0; i < child.count; i++) {
      child.getMatrixAt(i, matrix);
      matrix.decompose(position, quaternion, scale);
      scale.x = radius;
      scale.z = radius;
      matrix.compose(position, quaternion, scale);
      child.setMatrixAt(i, matrix);
    }
    child.instanceMatrix.needsUpdate = true;
  });
}

// Same live-mutation reasoning as setVoxelPreviewOpacity/setVoxelEdgeOpacity,
// for the node spheres - filtered by name for the same reason
// setVoxelEdgeOpacity is (the edge tubes are ALSO an InstancedMesh).
export function setVoxelNodeOpacity(object: THREE.Object3D, opacity: number): void {
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh && child.name === VOXEL_NODE_NAME) {
      (child.material as THREE.MeshBasicMaterial).opacity = opacity;
    }
  });
}

// Unlike the opacity setters above, this DOES rebuild geometry - a
// sphere's radius isn't a material property that can be mutated in place.
// Still cheap: one shared SphereGeometry for every instance (InstancedMesh),
// not one per node, so this is a single small geometry swap regardless of
// how many nodes exist. Takes cellSize explicitly (the caller already has
// it - VoxelizationService reads it off the cached VoxelizationStatus)
// rather than stashing it on the object's untyped userData bag: a typo'd
// or renamed string key there would compile fine and silently fall back
// to a wrong default, only visible by inspecting the rendered size.
// Filtered by name, same reasoning as setVoxelNodeOpacity.
export function setVoxelNodeSize(object: THREE.Object3D, size: number, cellSize: number): void {
  const radius = Math.max(MIN_NODE_RADIUS, cellSize * NODE_RADIUS_MAX_FACTOR * size);
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh && child.name === VOXEL_NODE_NAME) {
      const oldGeometry = child.geometry;
      child.geometry = new THREE.SphereGeometry(radius);
      oldGeometry.dispose();
    }
  });
}

// Guards against disposing the same preview twice - BatchedMesh.dispose()
// is NOT idempotent (it nulls its own internal texture references on the
// way out, so a second call throws trying to dispose() them again, not
// just a harmless no-op like a plain BufferGeometry's dispose()). The
// actual fix for a double-dispose is structural: disposal now happens in
// exactly one place (VoxelizationService.run/clearResult/pruneTo), and
// WorldCanvasComponent reads the service directly every frame instead of
// through a change-detection-gated @Input, so it can never still be
// holding (and rendering) a reference the service has already disposed -
// see world-canvas.component.ts's updateVoxelPreview. This WeakSet is a
// defense-in-depth backstop against a future call path reintroducing that
// mistake, not the primary defense.
const disposedPreviews = new WeakSet<THREE.Object3D>();

export function disposeVoxelPreview(object: THREE.Object3D): void {
  if (disposedPreviews.has(object)) {
    return;
  }
  disposedPreviews.add(object);
  disposeObject3D(object);
}
