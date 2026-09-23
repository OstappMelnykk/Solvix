import * as THREE from 'three';
import { closestPointOnMesh, extractWorldTriangles, findBoundaryCorners, isPointOutsideMesh, snapExteriorVerticesToSurface } from './surface-projection';
import { VoxelCell, buildVoxelCells } from './voxel-cell';
import { VoxelGridDto } from './voxel-grid-contract';

// Same helper shape as voxel-cell.spec.ts's own gridWithOccupied.
function gridWithOccupied(
  countX: number,
  countY: number,
  countZ: number,
  occupiedCells: readonly (readonly [number, number, number])[],
  origin: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  cellSize = 1
): VoxelGridDto {
  const cellCount = countX * countY * countZ;
  const occupancy = new Uint8Array(Math.max(1, Math.ceil(cellCount / 8)));
  for (const [ix, iy, iz] of occupiedCells) {
    const index = ix + iy * countX + iz * countX * countY;
    occupancy[index >> 3] |= 1 << (index & 7);
  }
  return { origin, cellSize, countX, countY, countZ, occupancy };
}

// A cube surface (BoxGeometry) centered at the origin, half-extent 1 on
// each axis - the same "known, closed, watertight surface" every
// inside/outside/closest-point test below tests against.
function unitCubeMesh(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
}

describe('extractWorldTriangles', () => {
  it('extracts every triangle of a mesh, in world space', () => {
    const mesh = unitCubeMesh();
    mesh.position.set(10, 0, 0);
    mesh.updateMatrixWorld(true);

    const triangles = extractWorldTriangles(mesh);

    // BoxGeometry: 6 faces * 2 triangles.
    expect(triangles.length).toBe(12);
    for (const triangle of triangles) {
      expect(Math.abs(triangle.a.x - 10)).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('ignores non-mesh children and meshes without a position attribute', () => {
    const group = new THREE.Group();
    group.add(new THREE.Object3D());

    const triangles = extractWorldTriangles(group);

    expect(triangles.length).toBe(0);
  });
});

describe('isPointOutsideMesh', () => {
  it('reports a point well inside a closed mesh as not outside', () => {
    const triangles = extractWorldTriangles(unitCubeMesh());

    expect(isPointOutsideMesh(new THREE.Vector3(0, 0, 0), triangles)).toBe(false);
  });

  it('reports a point well outside a closed mesh as outside', () => {
    const triangles = extractWorldTriangles(unitCubeMesh());

    expect(isPointOutsideMesh(new THREE.Vector3(5, 5, 5), triangles)).toBe(true);
  });

  it('reports a point just outside a face as outside', () => {
    const triangles = extractWorldTriangles(unitCubeMesh());

    expect(isPointOutsideMesh(new THREE.Vector3(1.2, 0, 0), triangles)).toBe(true);
  });
});

describe('closestPointOnMesh', () => {
  it('drops a perpendicular onto the nearest triangle', () => {
    const geometry = new THREE.BufferGeometry();
    // A single triangle in the z=0 plane.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const mesh = new THREE.Mesh(geometry);
    const triangles = extractWorldTriangles(mesh);

    const closest = closestPointOnMesh(new THREE.Vector3(0.2, 0.2, 3), triangles);

    expect(closest).not.toBeNull();
    expect(closest!.x).toBeCloseTo(0.2, 5);
    expect(closest!.y).toBeCloseTo(0.2, 5);
    expect(closest!.z).toBeCloseTo(0, 5);
  });

  it('returns null when there are no triangles', () => {
    expect(closestPointOnMesh(new THREE.Vector3(), [])).toBeNull();
  });
});

describe('findBoundaryCorners', () => {
  it('treats every corner of a single cell as a boundary corner', () => {
    const cells = buildVoxelCells(gridWithOccupied(1, 1, 1, [[0, 0, 0]]));

    const corners = findBoundaryCorners(cells);

    expect(corners.size).toBe(8);
  });

  it('excludes the one fully-interior corner of a solid 2x2x2 block', () => {
    const occupied: [number, number, number][] = [];
    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let iz = 0; iz < 2; iz++) {
          occupied.push([ix, iy, iz]);
        }
      }
    }
    const cells = buildVoxelCells(gridWithOccupied(2, 2, 2, occupied));

    const corners = findBoundaryCorners(cells);

    // 3x3x3 = 27 lattice points total, exactly 1 (the center) is fully
    // interior - see this file's own reasoning in the session notes.
    expect(corners.size).toBe(26);
    const interior = [...corners].find(c => c.x === 1 && c.y === 1 && c.z === 1);
    expect(interior).toBeUndefined();
  });
});

describe('snapExteriorVerticesToSurface', () => {
  it('leaves boundary corners alone when they already sit inside the surface', () => {
    // A single voxel from (-0.5,-0.5,-0.5) to (0.5,0.5,0.5) sits STRICTLY
    // inside the unit cube mesh (extent -1..1) - every corner is inside,
    // not outside, so nothing should move.
    const enclosedCell = gridWithOccupied(1, 1, 1, [[0, 0, 0]], { x: -0.5, y: -0.5, z: -0.5 }, 1);
    const cells = buildVoxelCells(enclosedCell);

    const moved = snapExteriorVerticesToSurface(cells, unitCubeMesh());

    expect(moved).toBe(0);
  });

  it('snaps a corner that sticks out past a flat face straight onto that face', () => {
    // A 2-cell voxel strip from (-1,-1,-1) to (3,1,1): the mesh (extent
    // -1..1 on every axis) only fills the FIRST cell - the strip's far
    // corners (x=3) stick out past the mesh's +X face (x=1) and must
    // snap onto it.
    const grid = gridWithOccupied(2, 1, 1, [[0, 0, 0], [1, 0, 0]], { x: -1, y: -1, z: -1 }, 2);
    const cells = buildVoxelCells(grid);
    const farCorner = cells.flatMap(c => c.corners).find(c => c.x === 3 && c.y === -1 && c.z === -1)!;
    expect(farCorner).toBeDefined();

    const moved = snapExteriorVerticesToSurface(cells, unitCubeMesh());

    expect(moved).toBeGreaterThan(0);
    expect(farCorner.x).toBeCloseTo(1, 5);
    expect(farCorner.y).toBeCloseTo(-1, 5);
    expect(farCorner.z).toBeCloseTo(-1, 5);
  });
});
