import * as THREE from 'three';
import { buildVoxelHexahedron, disposeVoxelHexahedron } from './voxel-hexahedron';
import { VoxelCell } from './voxel-cell';

// A unit cube's corners in the same order VoxelCell produces them (see
// voxel-cell.ts's cellCorners) - built by hand here so these tests don't
// depend on buildVoxelCells/VoxelGridDto at all, just on the corner
// convention both files share.
function unitCubeCell(): VoxelCell {
  const corners = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(0, 1, 1)
  ];
  return new VoxelCell(0, 0, 0, corners, new Array(6).fill(null));
}

function fillOf(hex: THREE.Object3D): THREE.Mesh {
  return hex.children.find(child => child instanceof THREE.Mesh && !(child instanceof THREE.LineSegments)) as THREE.Mesh;
}

function edgesOf(hex: THREE.Object3D): THREE.LineSegments {
  return hex.children.find(child => child instanceof THREE.LineSegments) as THREE.LineSegments;
}

describe('buildVoxelHexahedron', () => {
  it('builds 6 faces x 2 triangles x 3 vertices (non-indexed)', () => {
    const fill = fillOf(buildVoxelHexahedron(unitCubeCell(), 0.5, 1));

    expect(fill.geometry.index).toBeNull();
    expect(fill.geometry.getAttribute('position').count).toBe(36);
    expect(fill.geometry.getAttribute('normal').count).toBe(36);
    expect(fill.geometry.getAttribute('color').count).toBe(36);
  });

  it('gives every face an outward-pointing normal', () => {
    const fill = fillOf(buildVoxelHexahedron(unitCubeCell(), 0.5, 1));
    const position = fill.geometry.getAttribute('position');
    const normal = fill.geometry.getAttribute('normal');
    const center = new THREE.Vector3(0.5, 0.5, 0.5);

    // One triangle per face is enough to characterize that face's normal
    // (each face is flat) - checked at every 6th vertex (the first vertex
    // of each face's first triangle).
    for (let face = 0; face < 6; face++) {
      const i = face * 6;
      const vertex = new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i));
      const faceNormal = new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i));
      const outward = vertex.clone().sub(center);
      expect(faceNormal.dot(outward)).toBeGreaterThan(0);
    }
  });

  it('uses the fill color for every vertex when no per-face colors are given', () => {
    const fill = fillOf(buildVoxelHexahedron(unitCubeCell(), 0.5, 1, { fillColor: 0xff0000 }));
    const color = fill.geometry.getAttribute('color');

    for (let i = 0; i < color.count; i++) {
      expect(color.getX(i)).toBeCloseTo(1, 5);
      expect(color.getY(i)).toBeCloseTo(0, 5);
      expect(color.getZ(i)).toBeCloseTo(0, 5);
    }
  });

  it('overrides a single face color while leaving the others at fillColor', () => {
    const fill = fillOf(buildVoxelHexahedron(unitCubeCell(), 0.5, 1, {
      fillColor: 0x000000,
      faceColors: [0x00ff00] // face 0 (-Z) only
    }));
    const color = fill.geometry.getAttribute('color');

    // Face 0 occupies vertices 0..5.
    expect(color.getY(0)).toBeCloseTo(1, 5);
    // Face 1 (+Z) starts at vertex 6, should still be fillColor (black).
    expect(color.getX(6)).toBeCloseTo(0, 5);
    expect(color.getY(6)).toBeCloseTo(0, 5);
    expect(color.getZ(6)).toBeCloseTo(0, 5);
  });

  it('sets fill and edge opacity independently', () => {
    const hex = buildVoxelHexahedron(unitCubeCell(), 0.4, 0.9);

    expect((fillOf(hex).material as THREE.MeshStandardMaterial).opacity).toBe(0.4);
    expect((edgesOf(hex).material as THREE.LineBasicMaterial).opacity).toBe(0.9);
  });

  it('draws 12 edges (24 points) matching the cell corners', () => {
    const edges = edgesOf(buildVoxelHexahedron(unitCubeCell(), 0.5, 1));

    expect(edges.geometry.getAttribute('position').count).toBe(24);
  });

  it('is built directly in world space - the cell corners are baked into the geometry, not a transform', () => {
    const cell = unitCubeCell();
    const hex = buildVoxelHexahedron(cell, 0.5, 1);

    expect(hex.position.equals(new THREE.Vector3(0, 0, 0))).toBe(true);
    const fill = fillOf(hex);
    const position = fill.geometry.getAttribute('position');
    expect(position.getX(0)).toBeGreaterThanOrEqual(0);
    expect(position.getX(0)).toBeLessThanOrEqual(1);
  });
});

describe('disposeVoxelHexahedron', () => {
  it('disposes both the fill and edge geometries/materials', () => {
    const hex = buildVoxelHexahedron(unitCubeCell(), 0.5, 1);
    const fill = fillOf(hex);
    const edges = edgesOf(hex);
    const fillGeometryDispose = spyOn(fill.geometry, 'dispose');
    const fillMaterialDispose = spyOn(fill.material as THREE.Material, 'dispose');
    const edgeGeometryDispose = spyOn(edges.geometry, 'dispose');
    const edgeMaterialDispose = spyOn(edges.material as THREE.Material, 'dispose');

    disposeVoxelHexahedron(hex);

    expect(fillGeometryDispose).toHaveBeenCalled();
    expect(fillMaterialDispose).toHaveBeenCalled();
    expect(edgeGeometryDispose).toHaveBeenCalled();
    expect(edgeMaterialDispose).toHaveBeenCalled();
  });
});
