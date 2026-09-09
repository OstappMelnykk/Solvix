import * as THREE from 'three';
import { VoxelGridDto, isOccupied, voxelCenter } from './voxel-grid-contract';

const VOXEL_COLOR = 0x9b59b6;
const EDGE_COLOR = 0xffffff;

// Instanced fill so a result with tens of thousands of cubes stays cheap to
// render - one draw call regardless of count, same reasoning as solid-mode
// imported-reference geometry (ordinary rasterization, not per-cube
// overhead) - plus one white LineSegments outlining every cube's 12 edges
// (a single flat position buffer, same technique as geometry/dimension-lines.ts,
// not per-instance geometry - InstancedMesh doesn't support LineSegments).
// Iterates the grid+bitmask directly (voxel-grid-contract.ts) rather than a
// materialized list of centers - one pass, collecting each occupied cell's
// center as it's found, so isOccupied's bit-test never runs twice per cell
// (an earlier version counted occupied cells first via countOccupied to
// size the InstancedMesh, then walked the grid again to fill it).
// Built directly in WORLD space: the grid's origin is already in world
// coordinates (the mesh sent to Solvix.Api was baked from the DISPLAYED
// scaled reference's own world transform - see VoxelizationService.run /
// geometry/mesh-contract.ts's toMeshBinary), so the returned group is meant
// to be added to the scene at identity - no position/quaternion copying
// needed, unlike dimension lines/ruler (which are built in a LOCAL,
// pivot-centered frame instead).
export function buildVoxelPreview(grid: VoxelGridDto, fillOpacity: number, edgeOpacity: number): THREE.Object3D {
  const group = new THREE.Group();
  const half = grid.cellSize / 2;

  const occupiedCenters: { x: number; y: number; z: number }[] = [];
  for (let ix = 0; ix < grid.countX; ix++) {
    for (let iy = 0; iy < grid.countY; iy++) {
      for (let iz = 0; iz < grid.countZ; iz++) {
        if (isOccupied(grid, ix, iy, iz)) {
          occupiedCenters.push(voxelCenter(grid, ix, iy, iz));
        }
      }
    }
  }

  const geometry = new THREE.BoxGeometry(grid.cellSize, grid.cellSize, grid.cellSize);
  const material = new THREE.MeshStandardMaterial({ color: VOXEL_COLOR, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide });
  const fill = new THREE.InstancedMesh(geometry, material, occupiedCenters.length);
  // The cube fill and the imported reference mesh are both transparent AND
  // literally overlapping (that's the whole point of conservative
  // voxelization: cubes touch/enclose the surface). Three.js sorts
  // transparent objects by camera distance before drawing them, and as the
  // camera orbits, that sort order between "the mesh" and "the cube fill"
  // can flip - whichever object draws FIRST writes its depth, and the
  // other then fails the depth test wherever the two overlap and simply
  // doesn't draw there (not a blend - it reads as the mesh randomly
  // vanishing). renderOrder overrides distance-based sorting outright (Three.js
  // checks it before distance, only falling back to distance when two
  // objects share the same value) - a fixed, higher renderOrder than the
  // mesh's default (0) guarantees the mesh always draws first regardless
  // of camera angle, so its color is already in the framebuffer before the
  // cubes blend over it. Depth writing itself stays on (unlike an earlier
  // version of this fix that disabled it) - turning it off let neighboring
  // cube faces stop occluding each other entirely, so the fill's apparent
  // color drifted with camera angle depending on how many overlapping
  // translucent faces happened to be stacked along each pixel's view ray.
  fill.renderOrder = 1;

  const matrix = new THREE.Matrix4();
  const edgePositions: number[] = [];
  occupiedCenters.forEach((center, index) => {
    matrix.makeTranslation(center.x, center.y, center.z);
    fill.setMatrixAt(index, matrix);
    addCubeEdges(edgePositions, center, half);
  });
  fill.instanceMatrix.needsUpdate = true;
  group.add(fill);

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
  group.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: edgeOpacity })));

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
// Independent of the edge outline's own opacity (setVoxelEdgeOpacity) - the
// two are separate controls on purpose, since a fully-opaque wireframe
// stays readable even when the fill is turned nearly invisible, or vice
// versa.
export function setVoxelPreviewOpacity(object: THREE.Object3D, opacity: number): void {
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh) {
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

export function disposeVoxelPreview(object: THREE.Object3D): void {
  object.traverse(child => {
    if (child instanceof THREE.InstancedMesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    }
  });
}