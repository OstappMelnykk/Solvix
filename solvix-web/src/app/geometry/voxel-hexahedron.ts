import * as THREE from 'three';
import { VoxelCell } from './voxel-cell';

const DEFAULT_FILL_COLOR = 0x9b59b6;
const DEFAULT_EDGE_COLOR = 0xffffff;

// The 6 faces of a VoxelCell's 8 corners, each as 4 indices in
// counter-clockwise order WHEN VIEWED FROM OUTSIDE the cube (so the
// computed face normal below already points outward, without needing to
// trust any input winding - unlike an imported mesh, this geometry is ours
// to construct, so we just get the order right once, here).
const FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 3, 2, 1], // -Z (bottom)
  [4, 5, 6, 7], // +Z (top)
  [0, 4, 7, 3], // -X
  [1, 2, 6, 5], // +X
  [0, 1, 5, 4], // -Y
  [3, 7, 6, 2] // +Y
];

// The 12 edges, as pairs of corner indices - same corner ordering as
// FACES, one segment per edge. Exported so voxel-preview.ts's merged,
// all-cells-in-one-LineSegments edge outline (cheap - no per-object state
// worth batching separately, unlike the fill) can walk the same 12 pairs
// per cell without redefining them.
export const EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom face
  [4, 5], [5, 6], [6, 7], [7, 4], // top face
  [0, 4], [1, 5], [2, 6], [3, 7] // verticals
];

export interface VoxelHexahedronOptions {
  // Applied to every face that isn't overridden by faceColors.
  readonly fillColor?: THREE.ColorRepresentation;
  // One entry per FACES index (-Z,+Z,-X,+X,-Y,+Y) - lets a caller color
  // individual faces differently; omitted faces fall back to fillColor.
  readonly faceColors?: readonly (THREE.ColorRepresentation | undefined)[];
  readonly edgeColor?: THREE.ColorRepresentation;
}

// The fill geometry alone - 6 faces x 2 triangles x 3 vertices,
// non-indexed so each face keeps its own flat normal and vertex color.
// Factored out of buildVoxelHexahedron so voxel-preview.ts's BatchedMesh
// path (many voxels merged into one draw call) can pull just the
// geometry per cell via BatchedMesh.addGeometry(...) without building
// (and immediately discarding) a whole standalone Mesh/material/Group
// per voxel first.
export function buildVoxelHexahedronFillGeometry(cell: VoxelCell, options: VoxelHexahedronOptions = {}): THREE.BufferGeometry {
  const { corners } = cell;
  const fillColor = new THREE.Color(options.fillColor ?? DEFAULT_FILL_COLOR);

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  FACES.forEach((face, faceIndex) => {
    const [a, b, c, d] = face.map(i => corners[i]);
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const overrideColor = options.faceColors?.[faceIndex];
    const color = overrideColor !== undefined ? new THREE.Color(overrideColor) : fillColor;

    for (const triangle of [[a, b, c], [a, c, d]] as const) {
      for (const point of triangle) {
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(color.r, color.g, color.b);
      }
    }
  });

  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  fillGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  fillGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return fillGeometry;
}

// Builds ONE voxel as a fully standalone Object3D - its own fill Mesh
// (buildVoxelHexahedronFillGeometry above) and its own edge LineSegments,
// both with their own materials. Deliberately independent of any other
// voxel or of how many others exist - usable on its own (e.g. dropped
// straight into a scene for debugging). For rendering many voxels
// together efficiently, see voxel-preview.ts's BatchedMesh-based path,
// which uses buildVoxelHexahedronFillGeometry directly instead of this.
export function buildVoxelHexahedron(cell: VoxelCell, fillOpacity: number, edgeOpacity: number, options: VoxelHexahedronOptions = {}): THREE.Object3D {
  const fill = new THREE.Mesh(
    buildVoxelHexahedronFillGeometry(cell, options),
    new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide })
  );
  // Same z-fight fix as the batched preview (see voxel-preview.ts) - the
  // fill and the imported reference mesh are both transparent and
  // literally overlapping, so a fixed renderOrder keeps the mesh drawing
  // first regardless of camera angle.
  fill.renderOrder = 1;

  const { corners } = cell;
  const edgePositions: number[] = [];
  EDGES.forEach(([i, j]) => {
    const p0 = corners[i];
    const p1 = corners[j];
    edgePositions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
  });
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
  const edges = new THREE.LineSegments(
    edgeGeometry,
    new THREE.LineBasicMaterial({ color: options.edgeColor ?? DEFAULT_EDGE_COLOR, transparent: true, opacity: edgeOpacity })
  );

  const group = new THREE.Group();
  group.add(fill);
  group.add(edges);
  return group;
}

export function disposeVoxelHexahedron(object: THREE.Object3D): void {
  object.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    }
  });
}