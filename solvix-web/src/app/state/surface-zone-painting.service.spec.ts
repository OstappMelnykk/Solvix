import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import * as THREE from 'three';
import { SurfaceZonePaintingService, SurfaceZonePaintingSource, SurfaceZoneCellState } from './surface-zone-painting.service';
import { ZonePaintingService, ZonePaintingSource } from './zone-painting.service';
import { SessionsService } from './sessions.service';
import { VoxelizationService, VoxelizationStatus } from './voxelization.service';
import { VoxelGridDto } from '../geometry/voxel-grid-contract';

// A 2x1x1 solid voxel grid (both cells occupied) - just wide enough for 2
// physically distinct voxel zones (ix=0 and ix=1) to pair with 2 separate
// STL surface patches.
function buildVoxelGrid(): VoxelGridDto {
  return { origin: { x: 0, y: 0, z: 0 }, cellSize: 1, countX: 2, countY: 1, countZ: 1, occupancy: new Uint8Array([0b11]) };
}

function meshFromTriangles(positions: number[]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

// Finds an 'available' cell on `axis`'s view satisfying `predicate(u,v)` -
// used instead of hand-predicting exact shell-grid cell indices (fragile:
// depends on floor-division of triangle coordinates against a cell size
// that's an implementation detail of buildSurfaceShellGrid).
function firstAvailableCell(
  view: { width: number; height: number; cells: SurfaceZoneCellState[] },
  predicate: (u: number, v: number) => boolean
): { u: number; v: number } | null {
  for (let v = 0; v < view.height; v++) {
    for (let u = 0; u < view.width; u++) {
      if (view.cells[u + v * view.width].kind === 'available' && predicate(u, v)) {
        return { u, v };
      }
    }
  }
  return null;
}

const fakeZonePaintingSource: ZonePaintingSource = {
  scene: new THREE.Scene(),
  voxelPreview: new THREE.Object3D(),
  stlMesh: null,
  framingObjects: [],
  hiddenDuringView: []
};

// 4 small triangles spread across the grid's X extent [0,2): 2 in the
// "left" half (x<1, pairs with voxel zone 0) and 2 in the "right" half
// (x>=1, pairs with voxel zone 1), each pair spread far enough apart (by
// more than one shell cell) to land in 2 genuinely distinct shell columns -
// needed for the "same zone, 2 separate commits" test below.
function buildFourPatchMesh(): THREE.Mesh {
  const triangle = (cx: number, cy: number, cz: number): number[] => [
    cx - 0.02, cy - 0.02, cz, cx + 0.02, cy - 0.02, cz, cx, cy + 0.02, cz
  ];
  return meshFromTriangles([
    ...triangle(0.15, 0.1, 0.1), // left, patch 1
    ...triangle(0.85, 0.1, 0.1), // left, patch 2
    ...triangle(1.15, 0.1, 0.1), // right, patch 1
    ...triangle(1.85, 0.1, 0.1) // right, patch 2
  ]);
}

describe('SurfaceZonePaintingService', () => {
  let service: SurfaceZonePaintingService;
  let zonePainting: ZonePaintingService;
  let statuses: Map<number, VoxelizationStatus>;
  let stlMesh: THREE.Mesh;
  let source: SurfaceZonePaintingSource;

  beforeEach(() => {
    statuses = new Map();
    statuses.set(1, { kind: 'ok', result: buildVoxelGrid() });
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionsService, useValue: { sessions: signal([{ id: 1 }]) } },
        { provide: VoxelizationService, useValue: { getStatus: (id: number) => statuses.get(id) ?? { kind: 'idle' } } }
      ]
    });
    zonePainting = TestBed.inject(ZonePaintingService);
    service = TestBed.inject(SurfaceZonePaintingService);

    // Paint and save 2 voxel zones (zone 0 = ix=0, zone 1 = ix=1) - the
    // precondition this tool requires before it will even open.
    zonePainting.open(1, fakeZonePaintingSource);
    zonePainting.toggleCell(1, 'y', 0, 0);
    zonePainting.finishZone(1); // zone 0: ix=0
    zonePainting.toggleCell(1, 'y', 1, 0);
    zonePainting.finishZone(1); // zone 1: ix=1
    zonePainting.save(1);

    stlMesh = buildFourPatchMesh();
    source = { scene: new THREE.Scene(), stlMesh, framingObjects: [], hiddenDuringView: [] };
  });

  it('refuses to open before the voxel zoning is saved', () => {
    zonePainting.resetZones(1); // back to no zones, definitely not saved
    expect(service.open(1, source)).toBe(false);
    expect(service.activeSessionId()).toBeNull();
  });

  it('opens once the voxel zoning is saved, seeding one voxel-zone option per voxel zone', () => {
    expect(service.open(1, source)).toBe(true);
    expect(service.activeSessionId()).toBe(1);
    const session = service.getSession(1);
    expect(session?.voxelZones.map(zone => zone.voxelZoneId)).toEqual([0, 1]);
  });

  it('commits a selection into the currently active voxel zone, not a brand-new one', () => {
    service.open(1, source);
    const halfway = service.getSession(1)!.grid.countX / 2;
    const cell = firstAvailableCell(service.viewState(1, 'y'), u => u < halfway)!;
    expect(cell).toBeTruthy();

    service.setActiveVoxelZoneId(1, 0);
    expect(service.toggleCell(1, 'y', cell.u, cell.v)).toBe(true);
    const assigned = service.finishSelection(1);

    expect(assigned).toBeGreaterThan(0);
    expect(service.viewState(1, 'y').cells[cell.u + cell.v * service.getSession(1)!.grid.countX]).toEqual({
      kind: 'zoned',
      color: jasmine.any(String)
    });
  });

  it('lets the same voxel zone receive a second, separate selection', () => {
    service.open(1, source);
    const halfway = service.getSession(1)!.grid.countX / 2;
    service.setActiveVoxelZoneId(1, 0);

    const first = firstAvailableCell(service.viewState(1, 'y'), u => u < halfway)!;
    expect(service.toggleCell(1, 'y', first.u, first.v)).toBe(true);
    const firstAssigned = service.finishSelection(1);
    expect(firstAssigned).toBeGreaterThan(0);

    // A second, disjoint patch on the SAME (zone 0) side - buildFourPatchMesh
    // put 2 separate triangles there specifically so this cell exists.
    const second = firstAvailableCell(service.viewState(1, 'y'), u => u < halfway)!;
    expect(second).toBeTruthy();
    expect(service.toggleCell(1, 'y', second.u, second.v)).toBe(true);
    const secondAssigned = service.finishSelection(1);

    expect(secondAssigned).toBeGreaterThan(0);
    expect(service.allVoxelZonesUsed(1)).toBe(false); // zone 1 still untouched
  });

  // buildFourPatchMesh's 2 triangles per side are spatially FAR apart (not
  // 4-connected to each other) - selecting both in one rectangle would
  // violate the "must stay one connected piece" rule and get rejected
  // outright, so each available cell is committed in its OWN toggleCell +
  // finishSelection pair instead (each a trivially-connected single cell) -
  // exactly the "one voxel zone, several separate commits" workflow this
  // tool is meant to support (file header point 1).
  function assignAllAvailableCells(u: number, halfway: number, side: 'left' | 'right', voxelZoneId: number): void {
    service.setActiveVoxelZoneId(1, voxelZoneId);
    const matchesSide = (cellU: number): boolean => (side === 'left' ? cellU < halfway : cellU >= halfway);
    let cell = firstAvailableCell(service.viewState(1, 'y'), matchesSide);
    while (cell) {
      service.toggleCell(1, 'y', cell.u, cell.v);
      service.finishSelection(1);
      cell = firstAvailableCell(service.viewState(1, 'y'), matchesSide);
    }
  }

  it('requires full coverage AND every voxel zone used before it can be saved', () => {
    service.open(1, source);
    const before = service.coverage(1)!;
    expect(before.total).toBeGreaterThan(0);

    // Only assign zone 0's own cells (the whole left half) - zone 1 is
    // never used.
    const halfway = service.getSession(1)!.grid.countX / 2;
    assignAllAvailableCells(0, halfway, 'left', 0);

    expect(service.allVoxelZonesUsed(1)).toBe(false);
    expect(service.save(1, stlMesh)).toBe(false);
    expect(service.isSaved(1)).toBe(false);
  });

  it('saves once coverage is complete and every voxel zone was used, and exposes the triangle->zone mapping', () => {
    service.open(1, source);
    const halfway = service.getSession(1)!.grid.countX / 2;

    assignAllAvailableCells(0, halfway, 'left', 0);
    assignAllAvailableCells(0, halfway, 'right', 1);

    const coverage = service.coverage(1)!;
    expect(coverage.assigned).toBe(coverage.total);
    expect(service.allVoxelZonesUsed(1)).toBe(true);
    expect(service.save(1, stlMesh)).toBe(true);
    expect(service.isSaved(1)).toBe(true);

    // 4 triangles in mesh order: left, left, right, right.
    expect(service.zoneIdOfTriangle(1, 0)).toBe(0);
    expect(service.zoneIdOfTriangle(1, 1)).toBe(0);
    expect(service.zoneIdOfTriangle(1, 2)).toBe(1);
    expect(service.zoneIdOfTriangle(1, 3)).toBe(1);
  });

  it('resetSelections wipes committed assignments back to a blank slate', () => {
    service.open(1, source);
    const halfway = service.getSession(1)!.grid.countX / 2;
    assignAllAvailableCells(0, halfway, 'left', 0);
    expect(service.coverage(1)!.assigned).toBeGreaterThan(0);

    service.resetSelections(1);
    expect(service.coverage(1)!.assigned).toBe(0);
    expect(service.allVoxelZonesUsed(1)).toBe(false);
  });
});
