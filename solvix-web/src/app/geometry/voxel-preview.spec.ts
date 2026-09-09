import * as THREE from 'three';
import { buildVoxelPreview, disposeVoxelPreview, setVoxelEdgeOpacity, setVoxelPreviewOpacity } from './voxel-preview';
import { VoxelGridDto } from './voxel-grid-contract';

function fillOf(preview: THREE.Object3D): THREE.InstancedMesh {
  return preview.children.find(child => child instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
}

function edgesOf(preview: THREE.Object3D): THREE.LineSegments {
  return preview.children.find(child => child instanceof THREE.LineSegments) as THREE.LineSegments;
}

// Builds a grid whose occupied cells' centers land exactly on `centers` -
// tests care about resulting world positions, not the grid indices that
// produce them, so this hides the origin/index arithmetic. All requested
// centers must be `cellSize` apart along X, starting at the smallest.
function gridWithCentersAlongX(centers: number[], cellSize: number): VoxelGridDto {
  const countX = centers.length;
  const origin = { x: centers.length ? centers[0] - cellSize / 2 : 0, y: -cellSize / 2, z: -cellSize / 2 };
  const occupancy = new Uint8Array(Math.max(1, Math.ceil(countX / 8)));
  for (let i = 0; i < countX; i++) {
    occupancy[i >> 3] |= 1 << (i & 7);
  }
  return { origin, cellSize, countX: Math.max(countX, 1), countY: 1, countZ: 1, occupancy: countX === 0 ? new Uint8Array([0]) : occupancy };
}

function singleCellGridAt(center: { x: number; y: number; z: number }, cellSize: number): VoxelGridDto {
  const origin = { x: center.x - cellSize / 2, y: center.y - cellSize / 2, z: center.z - cellSize / 2 };
  return { origin, cellSize, countX: 1, countY: 1, countZ: 1, occupancy: new Uint8Array([0b1]) };
}

const EMPTY_GRID: VoxelGridDto = { origin: { x: 0, y: 0, z: 0 }, cellSize: 1, countX: 1, countY: 1, countZ: 1, occupancy: new Uint8Array([0]) };

describe('buildVoxelPreview', () => {
  it('creates one instance per occupied cell, sized to cellSize', () => {
    const grid = gridWithCentersAlongX([0, 2, 4], 2);

    const fill = fillOf(buildVoxelPreview(grid, 0.5, 1));

    expect(fill.count).toBe(3);
    const parameters = (fill.geometry as THREE.BoxGeometry).parameters;
    expect(parameters.width).toBe(2);
    expect(parameters.height).toBe(2);
    expect(parameters.depth).toBe(2);
  });

  it('places each instance at its center via the instance matrix', () => {
    const grid = singleCellGridAt({ x: 5, y: -3, z: 7 }, 1);

    const fill = fillOf(buildVoxelPreview(grid, 0.5, 1));

    const matrix = new THREE.Matrix4();
    fill.getMatrixAt(0, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(5, 5);
    expect(position.y).toBeCloseTo(-3, 5);
    expect(position.z).toBeCloseTo(7, 5);
  });

  it('sets the fill material opacity from the given value', () => {
    const fill = fillOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.25, 1));

    expect((fill.material as THREE.MeshStandardMaterial).opacity).toBe(0.25);
  });

  it('sets the edge material opacity from the given value, independent of the fill', () => {
    const edges = edgesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.9, 0.3));

    expect((edges.material as THREE.LineBasicMaterial).opacity).toBe(0.3);
  });

  it('draws a white edge outline with 12 edges (24 points) per cube', () => {
    const edges = edgesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1));

    expect((edges.material as THREE.LineBasicMaterial).color.getHex()).toBe(0xffffff);
    expect(edges.geometry.getAttribute('position').count).toBe(24); // 12 edges * 2 points
  });

  it('is built at identity - no position/quaternion baked into the group itself', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 5, y: 5, z: 5 }, 1), 0.5, 1);

    expect(preview.position.equals(new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(preview.quaternion.equals(new THREE.Quaternion())).toBe(true);
  });

  it('handles a grid with no occupied cells without throwing', () => {
    expect(() => buildVoxelPreview(EMPTY_GRID, 0.5, 1)).not.toThrow();
    expect(fillOf(buildVoxelPreview(EMPTY_GRID, 0.5, 1)).count).toBe(0);
  });
});

describe('setVoxelPreviewOpacity', () => {
  it('updates the fill material in place without touching the edge outline', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1);
    const edgeMaterial = edgesOf(preview).material as THREE.LineBasicMaterial;
    const edgeOpacityBefore = edgeMaterial.opacity;

    setVoxelPreviewOpacity(preview, 0.9);

    expect((fillOf(preview).material as THREE.MeshStandardMaterial).opacity).toBe(0.9);
    expect(edgesOf(preview).material).toBe(edgeMaterial);
    expect(edgeMaterial.opacity).toBe(edgeOpacityBefore);
  });
});

describe('setVoxelEdgeOpacity', () => {
  it('updates the edge material in place without touching the fill', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1);
    const fillMaterial = fillOf(preview).material as THREE.MeshStandardMaterial;
    const fillOpacityBefore = fillMaterial.opacity;

    setVoxelEdgeOpacity(preview, 0.2);

    expect((edgesOf(preview).material as THREE.LineBasicMaterial).opacity).toBe(0.2);
    expect(fillOf(preview).material).toBe(fillMaterial);
    expect(fillMaterial.opacity).toBe(fillOpacityBefore);
  });
});

describe('disposeVoxelPreview', () => {
  it('disposes both the instanced fill and the edge outline', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1);
    const fill = fillOf(preview);
    const edges = edgesOf(preview);
    const fillGeometryDispose = spyOn(fill.geometry, 'dispose');
    const fillMaterialDispose = spyOn(fill.material as THREE.Material, 'dispose');
    const edgeGeometryDispose = spyOn(edges.geometry, 'dispose');
    const edgeMaterialDispose = spyOn(edges.material as THREE.Material, 'dispose');

    disposeVoxelPreview(preview);

    expect(fillGeometryDispose).toHaveBeenCalled();
    expect(fillMaterialDispose).toHaveBeenCalled();
    expect(edgeGeometryDispose).toHaveBeenCalled();
    expect(edgeMaterialDispose).toHaveBeenCalled();
  });
});