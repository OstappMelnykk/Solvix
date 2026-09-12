import * as THREE from 'three';
import {
  buildVoxelPreview,
  disposeVoxelPreview,
  getSelectedVoxelCell,
  getVoxelCellByInstanceId,
  setVoxelEdgeOpacity,
  setVoxelHighlight,
  setVoxelLineWidth,
  setVoxelNodeOpacity,
  setVoxelNodeSize,
  setVoxelPreviewOpacity
} from './voxels';
import { VoxelGridDto } from '../voxel-grid-contract';

function highlightOf(preview: THREE.Object3D): THREE.Mesh {
  return preview.children.find(child => child instanceof THREE.Mesh && child.name === 'voxel-highlight') as THREE.Mesh;
}

function fillOf(preview: THREE.Object3D): THREE.BatchedMesh {
  return preview.children.find(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh;
}

// Both the edge tubes and the node spheres are a THREE.InstancedMesh, so
// telling them apart needs the name buildVoxelPreview gives each one, not
// just the type.
function edgesOf(preview: THREE.Object3D): THREE.InstancedMesh {
  return preview.children.find(child => child instanceof THREE.InstancedMesh && child.name === 'voxel-edges') as THREE.InstancedMesh;
}

function nodesOf(preview: THREE.Object3D): THREE.InstancedMesh {
  return preview.children.find(child => child instanceof THREE.InstancedMesh && child.name === 'voxel-nodes') as THREE.InstancedMesh;
}

// The edge tubes' radius (X/Z scale) is baked into each instance's own
// transform matrix, not exposed as a plain property anywhere - this reads
// it back the same way setVoxelLineWidth itself does (decompose).
function edgeRadiusAt(edges: THREE.InstancedMesh, index: number): number {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  edges.getMatrixAt(index, matrix);
  matrix.decompose(position, quaternion, scale);
  return scale.x;
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
  it('creates one BatchedMesh instance per occupied cell', () => {
    const grid = gridWithCentersAlongX([0, 2, 4], 2);

    const fill = fillOf(buildVoxelPreview(grid, 0.5, 1, 1, 0.5, 1));

    expect(fill.instanceCount).toBe(3);
  });

  it('gives each cell its own geometry, sized and positioned at its world-space center', () => {
    const fill = fillOf(buildVoxelPreview(singleCellGridAt({ x: 5, y: -3, z: 7 }, 2), 0.5, 1, 1, 0.5, 1));

    const box = new THREE.Box3();
    fill.getBoundingBoxAt(0, box);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    expect(center.x).toBeCloseTo(5, 5);
    expect(center.y).toBeCloseTo(-3, 5);
    expect(center.z).toBeCloseTo(7, 5);
    expect(size.x).toBeCloseTo(2, 5);
    expect(size.y).toBeCloseTo(2, 5);
    expect(size.z).toBeCloseTo(2, 5);
  });

  it('sets the fill material opacity from the given value', () => {
    const fill = fillOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.25, 1, 1, 0.5, 1));

    expect((fill.material as THREE.MeshStandardMaterial).opacity).toBe(0.25);
  });

  it('sets the edge material opacity from the given value, independent of the fill', () => {
    const edges = edgesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.9, 0.3, 1, 0.5, 1));

    expect((edges.material as THREE.MeshBasicMaterial).opacity).toBe(0.3);
  });

  it('draws a white edge tube instance per edge (12 per cube)', () => {
    const edges = edgesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1));

    expect((edges.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xffffff);
    expect(edges.count).toBe(12);
  });

  it('sets the edge tube radius relative to cellSize and the given lineWidth', () => {
    const edges = edgesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 2), 0.5, 1, 1, 0.5, 1));

    // radius = cellSize(2) * EDGE_RADIUS_MAX_FACTOR(0.025) * lineWidth(1)
    expect(edgeRadiusAt(edges, 0)).toBeCloseTo(0.05, 5);
  });

  it('never collapses the edge tubes to a zero radius at lineWidth=0', () => {
    const edges = edgesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 0, 0.5, 1));

    expect(edgeRadiusAt(edges, 0)).toBeGreaterThan(0);
  });

  it('positions and orients an edge tube to span exactly between its two corners', () => {
    // cellSize 2, centered at origin - corners are at +-1 on each axis, so
    // the vertical edge along +Z at the (-1,-1) XY corner runs from
    // (-1,-1,-1) to (-1,-1,1): midpoint (-1,-1,0), length 2, direction +Z.
    const edges = edgesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 2), 0.5, 1, 1, 0.5, 1));

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    // EDGES[8] = [0,4] - the vertical edge at corner 0 (voxel-hexahedron.ts's
    // own corner-order comment: 0-3 the -Z face, 4-7 the +Z face, same XY
    // per pair).
    edges.getMatrixAt(8, matrix);
    matrix.decompose(position, quaternion, scale);

    expect(position.x).toBeCloseTo(-1, 5);
    expect(position.y).toBeCloseTo(-1, 5);
    expect(position.z).toBeCloseTo(0, 5);
    expect(scale.y).toBeCloseTo(2, 5); // the edge's own length (cellSize)
    // The unit cylinder's local +Y, rotated by this instance's quaternion,
    // should land on the edge's actual direction (+Z here).
    const orientedUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    expect(orientedUp.x).toBeCloseTo(0, 5);
    expect(orientedUp.y).toBeCloseTo(0, 5);
    expect(orientedUp.z).toBeCloseTo(1, 5);
  });

  it('is built at identity - no position/quaternion baked into the group itself', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 5, y: 5, z: 5 }, 1), 0.5, 1, 1, 0.5, 1);

    expect(preview.position.equals(new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(preview.quaternion.equals(new THREE.Quaternion())).toBe(true);
  });

  it('handles a grid with no occupied cells without throwing', () => {
    expect(() => buildVoxelPreview(EMPTY_GRID, 0.5, 1, 1, 0.5, 1)).not.toThrow();
    expect(fillOf(buildVoxelPreview(EMPTY_GRID, 0.5, 1, 1, 0.5, 1)).instanceCount).toBe(0);
    expect(edgesOf(buildVoxelPreview(EMPTY_GRID, 0.5, 1, 1, 0.5, 1)).count).toBe(0);
  });

  it('draws one sphere per corner for a single, isolated cube', () => {
    const nodes = nodesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1));

    expect(nodes.count).toBe(8);
  });

  // Regression: two face-adjacent voxels share 4 corners (their common
  // face) - those must collapse to a single sphere each, not one per cell
  // that touches them. 8 + 8 corners with 4 shared = 12 unique, not 16.
  it('draws one sphere per UNIQUE node - shared corners between adjacent cubes are not duplicated', () => {
    const grid = gridWithCentersAlongX([0, 1], 1); // two cubes, touching face-to-face

    const nodes = nodesOf(buildVoxelPreview(grid, 0.5, 1, 1, 0.5, 1));

    expect(nodes.count).toBe(12);
  });

  it('sizes node spheres relative to cellSize and the given nodeSize', () => {
    const nodes = nodesOf(buildVoxelPreview(singleCellGridAt({ x: 5, y: -3, z: 7 }, 2), 0.5, 1, 1, 1, 1));

    // radius = cellSize * NODE_RADIUS_MAX_FACTOR(0.12) * nodeSize(1)
    expect((nodes.geometry as THREE.SphereGeometry).parameters.radius).toBeCloseTo(0.24, 5);
  });

  it('positions node spheres at the cube corners', () => {
    const nodes = nodesOf(buildVoxelPreview(singleCellGridAt({ x: 5, y: -3, z: 7 }, 2), 0.5, 1, 1, 0.5, 1));

    const matrix = new THREE.Matrix4();
    nodes.getMatrixAt(0, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    // One of the 8 corners of a cube centered at (5,-3,7), half-size 1.
    expect(Math.abs(position.x - 5)).toBeCloseTo(1, 5);
    expect(Math.abs(position.y - -3)).toBeCloseTo(1, 5);
    expect(Math.abs(position.z - 7)).toBeCloseTo(1, 5);
  });

  it('sets the node material opacity from the given value', () => {
    const nodes = nodesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 0.4));

    expect((nodes.material as THREE.MeshBasicMaterial).opacity).toBe(0.4);
  });

  it('never collapses to a zero-radius sphere at nodeSize=0', () => {
    const nodes = nodesOf(buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0, 1));

    expect((nodes.geometry as THREE.SphereGeometry).parameters.radius).toBeGreaterThan(0);
  });
});

describe('setVoxelPreviewOpacity', () => {
  it('updates the fill material in place without touching the edge tubes or nodes', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);
    const edgeMaterial = edgesOf(preview).material as THREE.MeshBasicMaterial;
    const edgeOpacityBefore = edgeMaterial.opacity;
    const nodeMaterial = nodesOf(preview).material as THREE.MeshBasicMaterial;
    const nodeOpacityBefore = nodeMaterial.opacity;

    setVoxelPreviewOpacity(preview, 0.9);

    expect((fillOf(preview).material as THREE.MeshStandardMaterial).opacity).toBe(0.9);
    expect(edgesOf(preview).material).toBe(edgeMaterial);
    expect(edgeMaterial.opacity).toBe(edgeOpacityBefore);
    expect(nodeMaterial.opacity).toBe(nodeOpacityBefore);
  });
});

describe('setVoxelEdgeOpacity', () => {
  it('updates the edge material in place without touching the fill or the nodes', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);
    const fillMaterial = fillOf(preview).material as THREE.MeshStandardMaterial;
    const fillOpacityBefore = fillMaterial.opacity;
    const nodeMaterial = nodesOf(preview).material as THREE.MeshBasicMaterial;
    const nodeOpacityBefore = nodeMaterial.opacity;

    setVoxelEdgeOpacity(preview, 0.2);

    expect((edgesOf(preview).material as THREE.MeshBasicMaterial).opacity).toBe(0.2);
    expect(fillOf(preview).material).toBe(fillMaterial);
    expect(fillMaterial.opacity).toBe(fillOpacityBefore);
    expect(nodeMaterial.opacity).toBe(nodeOpacityBefore);
  });
});

describe('setVoxelLineWidth', () => {
  it('updates every edge tube radius in place without touching their opacity, orientation, or the fill', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 2), 0.5, 1, 0.25, 0.5, 1);
    const fillMaterial = fillOf(preview).material as THREE.MeshStandardMaterial;
    const edgeOpacityBefore = (edgesOf(preview).material as THREE.MeshBasicMaterial).opacity;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    edgesOf(preview).getMatrixAt(8, matrix);
    matrix.decompose(position, quaternion, scale);
    const lengthBefore = scale.y;

    setVoxelLineWidth(preview, 1, 2);

    // radius = cellSize(2) * EDGE_RADIUS_MAX_FACTOR(0.025) * width(1)
    expect(edgeRadiusAt(edgesOf(preview), 8)).toBeCloseTo(0.05, 5);
    expect((edgesOf(preview).material as THREE.MeshBasicMaterial).opacity).toBe(edgeOpacityBefore);
    expect(fillOf(preview).material).toBe(fillMaterial);
    edgesOf(preview).getMatrixAt(8, matrix);
    matrix.decompose(position, quaternion, scale);
    expect(scale.y).toBeCloseTo(lengthBefore, 5); // length untouched, only the radius changed
  });

  it('never collapses the edge tubes to a zero radius at width=0', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);

    setVoxelLineWidth(preview, 0, 1);

    expect(edgeRadiusAt(edgesOf(preview), 0)).toBeGreaterThan(0);
  });
});

describe('setVoxelNodeOpacity', () => {
  it('updates the node material in place without touching the fill or edges', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);
    const fillMaterial = fillOf(preview).material as THREE.MeshStandardMaterial;
    const edgeMaterial = edgesOf(preview).material as THREE.MeshBasicMaterial;
    const edgeOpacityBefore = edgeMaterial.opacity;

    setVoxelNodeOpacity(preview, 0.3);

    expect((nodesOf(preview).material as THREE.MeshBasicMaterial).opacity).toBe(0.3);
    expect(fillOf(preview).material).toBe(fillMaterial);
    expect(edgesOf(preview).material).toBe(edgeMaterial);
    expect(edgeMaterial.opacity).toBe(edgeOpacityBefore);
  });
});

describe('setVoxelNodeSize', () => {
  it('replaces the shared sphere geometry with the new radius', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 2), 0.5, 1, 1, 0.5, 1);
    const before = (nodesOf(preview).geometry as THREE.SphereGeometry).parameters.radius;

    setVoxelNodeSize(preview, 1, 2);

    const after = (nodesOf(preview).geometry as THREE.SphereGeometry).parameters.radius;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(0.24, 5); // cellSize(2) * NODE_RADIUS_MAX_FACTOR(0.12) * size(1)
  });

  it('disposes the old geometry when swapping it, without touching the edge tubes', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);
    const oldGeometry = nodesOf(preview).geometry;
    const disposeSpy = spyOn(oldGeometry, 'dispose');
    const edgeGeometry = edgesOf(preview).geometry;

    setVoxelNodeSize(preview, 1, 1);

    expect(disposeSpy).toHaveBeenCalled();
    expect(edgesOf(preview).geometry).toBe(edgeGeometry);
  });
});

describe('getVoxelCellByInstanceId', () => {
  it('resolves a valid instanceId to the cell at that grid position', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 5, y: -3, z: 7 }, 2), 0.5, 1, 1, 0.5, 1);

    const cell = getVoxelCellByInstanceId(preview, 0);

    expect(cell).not.toBeNull();
    expect(cell!.ix).toBe(0);
    expect(cell!.iy).toBe(0);
    expect(cell!.iz).toBe(0);
  });

  it('returns null for an instanceId with no matching cell', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);

    expect(getVoxelCellByInstanceId(preview, 999)).toBeNull();
  });

  it('returns null for a preview that was never built by buildVoxelPreview', () => {
    expect(getVoxelCellByInstanceId(new THREE.Group(), 0)).toBeNull();
  });
});

describe('setVoxelHighlight', () => {
  it('adds a hidden highlight overlay by default', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);

    expect(highlightOf(preview).visible).toBe(false);
  });

  it('shows and centers the overlay on the given cell', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 5, y: -3, z: 7 }, 2), 0.5, 1, 1, 0.5, 1);
    const cell = getVoxelCellByInstanceId(preview, 0)!;

    setVoxelHighlight(preview, cell);

    const highlight = highlightOf(preview);
    expect(highlight.visible).toBe(true);
    expect(highlight.position.x).toBeCloseTo(5, 5);
    expect(highlight.position.y).toBeCloseTo(-3, 5);
    expect(highlight.position.z).toBeCloseTo(7, 5);
  });

  it('hides the overlay again when passed null', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);
    setVoxelHighlight(preview, getVoxelCellByInstanceId(preview, 0));

    setVoxelHighlight(preview, null);

    expect(highlightOf(preview).visible).toBe(false);
  });

  it('moving the selection to a different cell repositions the same overlay mesh, without adding another', () => {
    const grid = gridWithCentersAlongX([0, 2, 4], 2);
    const preview = buildVoxelPreview(grid, 0.5, 1, 1, 0.5, 1);
    const highlightsBefore = preview.children.filter(child => child instanceof THREE.Mesh && child.name === 'voxel-highlight');

    setVoxelHighlight(preview, getVoxelCellByInstanceId(preview, 0));
    setVoxelHighlight(preview, getVoxelCellByInstanceId(preview, 2));

    const highlightsAfter = preview.children.filter(child => child instanceof THREE.Mesh && child.name === 'voxel-highlight');
    expect(highlightsAfter.length).toBe(highlightsBefore.length);
    expect(highlightOf(preview).position.x).toBeCloseTo(4, 5);
  });
});

describe('getSelectedVoxelCell', () => {
  it('returns null when nothing has been selected yet', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);

    expect(getSelectedVoxelCell(preview)).toBeNull();
  });

  it('returns the cell that setVoxelHighlight last selected', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 5, y: -3, z: 7 }, 2), 0.5, 1, 1, 0.5, 1);
    const cell = getVoxelCellByInstanceId(preview, 0)!;

    setVoxelHighlight(preview, cell);

    expect(getSelectedVoxelCell(preview)).toBe(cell);
  });

  it('returns null again after the selection is cleared', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);
    setVoxelHighlight(preview, getVoxelCellByInstanceId(preview, 0));

    setVoxelHighlight(preview, null);

    expect(getSelectedVoxelCell(preview)).toBeNull();
  });
});

describe('disposeVoxelPreview', () => {
  it('is safe to call twice on the same object - BatchedMesh.dispose() itself is not idempotent', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);

    disposeVoxelPreview(preview);

    expect(() => disposeVoxelPreview(preview)).not.toThrow();
  });

  it('disposes the batched fill, the edge tubes, and the node spheres', () => {
    const preview = buildVoxelPreview(singleCellGridAt({ x: 0, y: 0, z: 0 }, 1), 0.5, 1, 1, 0.5, 1);
    const fill = fillOf(preview);
    const edges = edgesOf(preview);
    const nodes = nodesOf(preview);
    const fillDispose = spyOn(fill, 'dispose').and.callThrough();
    const fillMaterialDispose = spyOn(fill.material as THREE.Material, 'dispose');
    const edgeGeometryDispose = spyOn(edges.geometry, 'dispose');
    const edgeMaterialDispose = spyOn(edges.material as THREE.Material, 'dispose');
    const nodeGeometryDispose = spyOn(nodes.geometry, 'dispose');
    const nodeMaterialDispose = spyOn(nodes.material as THREE.Material, 'dispose');

    disposeVoxelPreview(preview);

    expect(fillDispose).toHaveBeenCalled();
    expect(fillMaterialDispose).toHaveBeenCalled();
    expect(edgeGeometryDispose).toHaveBeenCalled();
    expect(edgeMaterialDispose).toHaveBeenCalled();
    expect(nodeGeometryDispose).toHaveBeenCalled();
    expect(nodeMaterialDispose).toHaveBeenCalled();
  });
});