import * as THREE from 'three';
import { buildSurfaceShellGrid, assignTriangleZones } from './surface-shell-grid';
import { VoxelGridDto, isOccupied, countOccupied } from './voxel-grid-contract';

function buildVoxelGrid(countX: number, countY: number, countZ: number, cellSize = 1): VoxelGridDto {
  const cellCount = countX * countY * countZ;
  return {
    origin: { x: 0, y: 0, z: 0 },
    cellSize,
    countX,
    countY,
    countZ,
    occupancy: new Uint8Array(Math.ceil(cellCount / 8)).fill(0xff)
  };
}

function meshFromTriangles(positions: number[]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

describe('buildSurfaceShellGrid', () => {
  it('derives dimensions as an exact multiple of the voxel grid', () => {
    const voxelGrid = buildVoxelGrid(2, 3, 4, 2);
    const mesh = meshFromTriangles([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const shellGrid = buildSurfaceShellGrid(mesh, voxelGrid, 5);

    expect(shellGrid.countX).toBe(10);
    expect(shellGrid.countY).toBe(15);
    expect(shellGrid.countZ).toBe(20);
    expect(shellGrid.cellSize).toBeCloseTo(0.4, 10);
    expect(shellGrid.origin).toEqual(voxelGrid.origin);
  });

  it('marks the shell cell a small triangle sits in', () => {
    const voxelGrid = buildVoxelGrid(4, 4, 4, 1);
    // A tiny triangle entirely inside shell cell (2,2,2) at subdivisions=5,
    // cellSize=0.2 - center of the grid, well clear of any cell boundary.
    const mesh = meshFromTriangles([2.01, 2.01, 2.01, 2.05, 2.01, 2.01, 2.01, 2.05, 2.01]);
    const shellGrid = buildSurfaceShellGrid(mesh, voxelGrid, 5);

    expect(isOccupied(shellGrid, 10, 10, 10)).toBe(true);
    expect(countOccupied(shellGrid)).toBeGreaterThan(0);
    // Far corner of the grid should be untouched.
    expect(isOccupied(shellGrid, 0, 0, 0)).toBe(false);
  });

  it('leaves no gap along a triangle spanning many shell cells', () => {
    const voxelGrid = buildVoxelGrid(4, 1, 1, 1);
    // A long, thin triangle running the full length of the grid along X -
    // every shell column it crosses along X should end up marked, with no
    // unmarked cell sandwiched between two marked ones.
    const mesh = meshFromTriangles([0.01, 0.5, 0.5, 3.99, 0.5, 0.5, 0.01, 0.55, 0.5]);
    const shellGrid = buildSurfaceShellGrid(mesh, voxelGrid, 5);

    const touchedX: number[] = [];
    for (let ix = 0; ix < shellGrid.countX; ix++) {
      let touched = false;
      for (let iy = 0; iy < shellGrid.countY && !touched; iy++) {
        for (let iz = 0; iz < shellGrid.countZ && !touched; iz++) {
          if (isOccupied(shellGrid, ix, iy, iz)) {
            touched = true;
          }
        }
      }
      if (touched) {
        touchedX.push(ix);
      }
    }
    expect(touchedX.length).toBeGreaterThan(10);
    for (let i = 1; i < touchedX.length; i++) {
      expect(touchedX[i] - touchedX[i - 1]).toBe(1); // no gap
    }
  });

  it('produces an empty grid for an empty object', () => {
    const voxelGrid = buildVoxelGrid(2, 2, 2, 1);
    const shellGrid = buildSurfaceShellGrid(new THREE.Group(), voxelGrid, 5);
    expect(countOccupied(shellGrid)).toBe(0);
  });
});

describe('assignTriangleZones', () => {
  // Two triangles, far apart along X - triangle A's centroid near x=0.5
  // (shell ix ~2), triangle B's near x=3.5 (shell ix ~17).
  const trianglePositions = [
    0.4, 0.1, 0.1, 0.6, 0.1, 0.1, 0.5, 0.3, 0.1, // triangle A, centroid x~0.5
    3.4, 0.1, 0.1, 3.6, 0.1, 0.1, 3.5, 0.3, 0.1 // triangle B, centroid x~3.5
  ];

  it('assigns each triangle the zone of the shell cell its centroid falls in', () => {
    const voxelGrid = buildVoxelGrid(4, 1, 1, 1);
    const mesh = meshFromTriangles(trianglePositions);
    const shellGrid = buildSurfaceShellGrid(mesh, voxelGrid, 5);

    const zoneIdAt = (ix: number): number | null => (ix < 10 ? 7 : 9);
    const triangleZone = assignTriangleZones(mesh, shellGrid, zoneIdAt);

    expect(Array.from(triangleZone)).toEqual([7, 9]);
  });

  it('leaves a triangle unassigned (-1) when zoneIdAt reports no zone there', () => {
    const voxelGrid = buildVoxelGrid(4, 1, 1, 1);
    const mesh = meshFromTriangles(trianglePositions.slice(0, 9));
    const shellGrid = buildSurfaceShellGrid(mesh, voxelGrid, 5);

    const triangleZone = assignTriangleZones(mesh, shellGrid, () => null);
    expect(Array.from(triangleZone)).toEqual([-1]);
  });
});
