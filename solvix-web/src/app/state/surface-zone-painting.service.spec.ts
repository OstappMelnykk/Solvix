import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import * as THREE from 'three';
import { SurfaceZonePaintingService, SurfaceZonePaintingSource, SurfaceZoneCellState } from './surface-zone-painting.service';
import { ZonePaintingService, ZonePaintingSource } from './zone-painting.service';
import { SessionsService } from './sessions.service';
import { VoxelizationService, VoxelizationStatus } from './voxelization.service';
import { ImportedReferenceRenderService } from './imported-reference-render.service';
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
  let referenceRender: ImportedReferenceRenderService;
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
    referenceRender = TestBed.inject(ImportedReferenceRenderService);

    // Paint 2 voxel zones (zone 0 = ix=0, zone 1 = ix=1) - the wizard would
    // normally interleave these one at a time with their own STL step, but
    // committing both up front here is equivalent for tests that don't
    // specifically exercise that interleaving (see "mid-session zone
    // additions" below for one that does).
    zonePainting.open(1, fakeZonePaintingSource);
    zonePainting.toggleCell(1, 'y', 0, 0);
    zonePainting.finishZone(1); // zone 0: ix=0
    zonePainting.toggleCell(1, 'y', 1, 0);
    zonePainting.finishZone(1); // zone 1: ix=1

    stlMesh = buildFourPatchMesh();
    source = { scene: new THREE.Scene(), stlMesh, framingObjects: [], hiddenDuringView: [], step1Source: fakeZonePaintingSource };

    // recomputeTriangleZones (finishSelection/deleteZone) needs the actual
    // displayed STL mesh, which it reads from ImportedReferenceRenderService,
    // not from this tool's own activeSource - stub it the same way a real
    // import would populate it.
    spyOn(referenceRender, 'getScaledReference').and.returnValue(stlMesh);
  });

  it('refuses to open when there are no voxel zones yet', () => {
    zonePainting.resetZones(1); // back to no zones
    expect(service.open(1, source)).toBe(false);
    expect(service.activeSessionId()).toBeNull();
  });

  it('opens as soon as at least one voxel zone exists, seeding one voxel-zone option per voxel zone', () => {
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
    const { assigned } = service.finishSelection(1);

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
    const { assigned: firstAssigned } = service.finishSelection(1);
    expect(firstAssigned).toBeGreaterThan(0);

    // A second, disjoint patch on the SAME (zone 0) side - buildFourPatchMesh
    // put 2 separate triangles there specifically so this cell exists.
    const second = firstAvailableCell(service.viewState(1, 'y'), u => u < halfway)!;
    expect(second).toBeTruthy();
    expect(service.toggleCell(1, 'y', second.u, second.v)).toBe(true);
    const { assigned: secondAssigned } = service.finishSelection(1);

    expect(secondAssigned).toBeGreaterThan(0);
    expect(service.isZoneUsed(1, 1)).toBe(false); // zone 1 still untouched
  });

  // buildFourPatchMesh's 2 triangles per side are spatially FAR apart (not
  // 4-connected to each other) - committing both in one finishSelection
  // would violate the "must be one connected piece" rule enforced there and
  // get refused outright (0 assigned), so each available cell is committed
  // in its OWN toggleCell + finishSelection pair instead (each a trivially-
  // connected single cell) - exactly the "one voxel zone, several separate
  // commits" workflow this tool is meant to support (file header point 1).
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

  it('refuses to commit a disconnected pending selection, leaving it pending for the user to fix', () => {
    service.open(1, source);
    const halfway = service.getSession(1)!.grid.countX / 2;
    service.setActiveVoxelZoneId(1, 0);

    // Both available cells on the left side, toggled together without
    // bridging the gap between them - a disconnected pending mask.
    const first = firstAvailableCell(service.viewState(1, 'y'), u => u < halfway)!;
    service.toggleCell(1, 'y', first.u, first.v);
    const second = firstAvailableCell(service.viewState(1, 'y'), u => u < halfway)!;
    expect(second).toBeTruthy();
    service.toggleCell(1, 'y', second.u, second.v);

    const result = service.finishSelection(1);

    expect(result).toEqual({ assigned: 0, disconnected: true });
    expect(service.coverage(1)!.assigned).toBe(0);
    expect(service.pendingMask(1, 'y')![first.u + first.v * service.getSession(1)!.grid.countX]).toBe(1);
  });

  it('recomputes the triangle->zone mapping after a single zone commit, with no coverage requirement', () => {
    service.open(1, source);
    const halfway = service.getSession(1)!.grid.countX / 2;

    // Only zone 0's own cells - zone 1 is never touched, and coverage stays
    // partial. Neither used to gate anything anymore.
    assignAllAvailableCells(0, halfway, 'left', 0);

    expect(service.isZoneUsed(1, 1)).toBe(false);
    expect(service.coverage(1)!.assigned).toBeLessThan(service.coverage(1)!.total);
    // 4 triangles in mesh order: left, left, right, right - only the left
    // 2 (zone 0) are assigned yet.
    expect(service.zoneIdOfTriangle(1, 0)).toBe(0);
    expect(service.zoneIdOfTriangle(1, 1)).toBe(0);
    expect(service.zoneIdOfTriangle(1, 2)).toBeNull();
    expect(service.zoneIdOfTriangle(1, 3)).toBeNull();
  });

  it('exposes the full triangle->zone mapping once every zone has been painted', () => {
    service.open(1, source);
    const halfway = service.getSession(1)!.grid.countX / 2;

    assignAllAvailableCells(0, halfway, 'left', 0);
    assignAllAvailableCells(0, halfway, 'right', 1);

    const coverage = service.coverage(1)!;
    expect(coverage.assigned).toBe(coverage.total);
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
    expect(service.isZoneUsed(1, 0)).toBe(false);
  });

  describe('deleteZone', () => {
    it('frees the zone\'s shell cells and drops it from isZoneUsed', () => {
      service.open(1, source);
      const halfway = service.getSession(1)!.grid.countX / 2;
      assignAllAvailableCells(0, halfway, 'left', 0);
      expect(service.isZoneUsed(1, 0)).toBe(true);

      service.deleteZone(1, 0);

      expect(service.isZoneUsed(1, 0)).toBe(false);
      expect(service.coverage(1)!.assigned).toBe(0);
    });

    it('renumbers a later zone\'s cells down when an earlier zone is deleted', () => {
      service.open(1, source);
      const halfway = service.getSession(1)!.grid.countX / 2;
      assignAllAvailableCells(0, halfway, 'left', 0);
      assignAllAvailableCells(0, halfway, 'right', 1);

      service.deleteZone(1, 0); // ZonePaintingService.deleteZone would renumber zone 1 -> 0 too

      expect(service.isZoneUsed(1, 0)).toBe(true); // was zone 1, renumbered
      expect(service.zoneIdOfTriangle(1, 2)).toBe(0); // right-side triangle, was zone 1
    });
  });

  describe('pending selection cleared on close', () => {
    it("an abandoned (never finished) pending selection doesn't resurface on reopen", () => {
      service.open(1, source);
      service.setActiveVoxelZoneId(1, 0);
      const halfway = service.getSession(1)!.grid.countX / 2;
      const cell = firstAvailableCell(service.viewState(1, 'y'), u => u < halfway)!;
      service.toggleCell(1, 'y', cell.u, cell.v);
      expect(service.pendingMask(1, 'y')![cell.u + cell.v * service.getSession(1)!.grid.countX]).toBe(1);

      service.close(); // "Закрити" without finishSelection
      service.open(1, source);

      expect(service.pendingMask(1, 'y')![cell.u + cell.v * service.getSession(1)!.grid.countX]).toBe(0);
      expect(service.viewState(1, 'y').cells[cell.u + cell.v * service.getSession(1)!.grid.countX]).toEqual({ kind: 'available' });
    });
  });

  describe('mid-session zone additions (the interleaved wizard flow)', () => {
    it('keeps an already-painted zone\'s STL data when a NEW voxel zone is added afterward', () => {
      // Undo the outer beforeEach's 2 already-committed zones so there's
      // room to add a genuinely NEW one partway through this test - the
      // whole point being verified here.
      zonePainting.resetZones(1);
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1); // zone 0: ix=0

      service.open(1, source);
      const halfway = service.getSession(1)!.grid.countX / 2;
      assignAllAvailableCells(0, halfway, 'left', 0);
      const assignedBefore = service.coverage(1)!.assigned;
      expect(assignedBefore).toBeGreaterThan(0);

      // A new voxel zone appears (exactly as the wizard creates one after
      // finishing a zone's voxel step) - re-opening must NOT wipe the STL
      // work already done for zone 0.
      zonePainting.toggleCell(1, 'y', 1, 0);
      zonePainting.finishZone(1); // zone 1: ix=1

      expect(service.open(1, source)).toBe(true);
      expect(service.coverage(1)!.assigned).toBe(assignedBefore);
      expect(service.isZoneUsed(1, 0)).toBe(true);
    });
  });

  describe('discarding a session when its reference changes', () => {
    it('drops the shell-grid session once the source STL reference changes', () => {
      service.open(1, source);
      expect(service.getSession(1)).not.toBeNull();

      referenceRender.refreshScaledReference(1);

      expect(service.getSession(1)).toBeNull();
      expect(service.activeSessionId()).toBeNull();
    });
  });
});
