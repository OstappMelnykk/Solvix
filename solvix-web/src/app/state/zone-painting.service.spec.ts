import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import * as THREE from 'three';
import { ZonePaintingService, ZonePaintingSource } from './zone-painting.service';
import { SessionsService } from './sessions.service';
import { VoxelizationService, VoxelizationStatus } from './voxelization.service';
import { ImportedReferenceRenderService } from './imported-reference-render.service';
import { VoxelGridDto } from '../geometry/voxel-grid-contract';

function buildGrid(countX: number, countY: number, countZ: number): VoxelGridDto {
  const occupancy = new Uint8Array(Math.ceil((countX * countY * countZ) / 8)).fill(0xff);
  return { origin: { x: 0, y: 0, z: 0 }, cellSize: 1, countX, countY, countZ, occupancy };
}

// The service only stores this and hands it back to the component (which
// does the actual rendering/raycasting) - a bare stub is enough here.
const fakeSource: ZonePaintingSource = {
  scene: new THREE.Scene(),
  voxelPreview: new THREE.Object3D(),
  stlMesh: null,
  framingObjects: [],
  hiddenDuringView: []
};

describe('ZonePaintingService', () => {
  let service: ZonePaintingService;
  let statuses: Map<number, VoxelizationStatus>;

  beforeEach(() => {
    statuses = new Map();
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionsService, useValue: { sessions: signal([{ id: 1 }]) } },
        {
          provide: VoxelizationService,
          useValue: {
            getStatus: (id: number) => statuses.get(id) ?? { kind: 'idle' }
          }
        }
      ]
    });
    service = TestBed.inject(ZonePaintingService);
  });

  it('does not open when voxelization has not succeeded', () => {
    service.open(1, fakeSource);
    expect(service.activeSessionId()).toBeNull();
  });

  it('opens and exposes the grid once voxelization succeeded', () => {
    const grid = buildGrid(3, 1, 1);
    statuses.set(1, { kind: 'ok', result: grid });
    service.open(1, fakeSource);
    expect(service.activeSessionId()).toBe(1);
    expect(service.getSession(1)?.grid).toBe(grid);
    expect(service.getSession(1)?.zones).toEqual([]);
  });

  describe('connectivity', () => {
    beforeEach(() => {
      statuses.set(1, { kind: 'ok', result: buildGrid(3, 1, 1) });
      service.open(1, fakeSource);
    });

    it('accepts a single cell', () => {
      expect(service.toggleCell(1, 'y', 0, 0)).toBe(true);
      expect(Array.from(service.pendingMask(1, 'y')!)).toEqual([1, 0, 0]);
    });

    it('rejects a cell that would split the selection into 2 components', () => {
      service.toggleCell(1, 'y', 0, 0);
      expect(service.toggleCell(1, 'y', 2, 0)).toBe(false);
      expect(Array.from(service.pendingMask(1, 'y')!)).toEqual([1, 0, 0]);
    });

    it('accepts the same cell once it bridges the gap', () => {
      service.toggleCell(1, 'y', 0, 0);
      service.toggleCell(1, 'y', 1, 0);
      expect(service.toggleCell(1, 'y', 2, 0)).toBe(true);
      expect(Array.from(service.pendingMask(1, 'y')!)).toEqual([1, 1, 1]);
    });

    it('selectRect rejects a rectangle disconnected from the existing mask', () => {
      service.toggleCell(1, 'y', 0, 0);
      expect(service.selectRect(1, 'y', 2, 0, 2, 0)).toBe(false);
      expect(Array.from(service.pendingMask(1, 'y')!)).toEqual([1, 0, 0]);
    });

    it('selectRect accepts a rectangle union that stays connected', () => {
      expect(service.selectRect(1, 'y', 0, 0, 1, 0)).toBe(true);
      expect(Array.from(service.pendingMask(1, 'y')!)).toEqual([1, 1, 0]);
    });

    it('allows toggling an unclaimed pending cell back off', () => {
      service.toggleCell(1, 'y', 0, 0);
      expect(service.toggleCell(1, 'y', 0, 0)).toBe(true);
      expect(Array.from(service.pendingMask(1, 'y')!)).toEqual([0, 0, 0]);
    });
  });

  describe('finishZone', () => {
    beforeEach(() => {
      statuses.set(1, { kind: 'ok', result: buildGrid(2, 2, 1) });
      service.open(1, fakeSource);
    });

    it('assigns only the voxel at the true 3-way intersection', () => {
      service.selectRect(1, 'x', 0, 0, 1, 0); // both iy on the x-view
      service.selectRect(1, 'y', 0, 0, 1, 0); // both ix on the y-view
      service.toggleCell(1, 'z', 0, 0); // just (ix=0, iy=0) on the z-view

      const assigned = service.finishZone(1);

      expect(assigned).toBe(1);
      expect(service.zoneIdAt(1, 0, 0, 0)).toBe(0);
      expect(service.zoneIdAt(1, 1, 0, 0)).toBeNull();
      expect(service.zoneIdAt(1, 0, 1, 0)).toBeNull();
      expect(service.zoneIdAt(1, 1, 1, 0)).toBeNull();
      expect(service.getSession(1)?.zones.length).toBe(1);
    });

    it('treats an untouched axis (x and y left blank) as unconstrained, so only the z-mask restricts the result', () => {
      service.toggleCell(1, 'z', 0, 0); // z-view: only (ix=0, iy=0) selected

      const assigned = service.finishZone(1);

      expect(assigned).toBe(1);
      expect(service.zoneIdAt(1, 0, 0, 0)).toBe(0);
    });

    it('reports coverage as the sum of committed zones out of every occupied cell', () => {
      expect(service.coverage(1)).toEqual({ assigned: 0, total: 4 });

      service.toggleCell(1, 'z', 0, 0);
      service.finishZone(1);

      expect(service.coverage(1)).toEqual({ assigned: 1, total: 4 });
      expect(service.getSession(1)?.zones[0].voxelCount).toBe(1);
    });

    it('reaches full coverage once every occupied cell is claimed by some zone', () => {
      service.selectRect(1, 'x', 0, 0, 1, 0);
      service.selectRect(1, 'y', 0, 0, 1, 0);
      service.selectRect(1, 'z', 0, 0, 1, 1);
      service.finishZone(1);

      expect(service.coverage(1)).toEqual({ assigned: 4, total: 4 });
    });

    it('clears the pending masks after committing', () => {
      service.toggleCell(1, 'x', 0, 0);
      service.toggleCell(1, 'y', 0, 0);
      service.toggleCell(1, 'z', 0, 0);
      service.finishZone(1);

      expect(Array.from(service.pendingMask(1, 'x')!)).toEqual([0, 0]);
    });

    // A 3-way mask contradiction (masks that individually looked fine but
    // share no common voxel) is no longer reachable through toggleCell/
    // selectRect at all: both now refuse to ADD a cell unless it already
    // classifies as 'available', and by construction the voxel that made it
    // available is a live witness that the intersection stays non-empty
    // after every single successful add. The only way `finishZone` still
    // returns 0 is the degenerate case below - nothing pending, and every
    // voxel already belongs to an earlier zone.
    it('returns 0 and creates no new zone when finishing with nothing pending and everything already zoned', () => {
      service.selectRect(1, 'x', 0, 0, 1, 0);
      service.selectRect(1, 'y', 0, 0, 1, 0);
      service.selectRect(1, 'z', 0, 0, 1, 1);
      expect(service.finishZone(1)).toBe(4); // first zone claims the whole grid

      const assigned = service.finishZone(1); // nothing pending this time

      expect(assigned).toBe(0);
      expect(service.getSession(1)?.zones.length).toBe(1);
    });
  });

  describe('already-zoned voxels cannot be repainted', () => {
    beforeEach(() => {
      statuses.set(1, { kind: 'ok', result: buildGrid(2, 2, 1) });
      service.open(1, fakeSource);
      // Commit one zone covering the entire 2x2x1 grid.
      service.selectRect(1, 'x', 0, 0, 1, 0);
      service.selectRect(1, 'y', 0, 0, 1, 0);
      service.selectRect(1, 'z', 0, 0, 1, 1);
      expect(service.finishZone(1)).toBe(4);
    });

    it('refuses to toggle a cell whose entire column is already zoned', () => {
      expect(service.toggleCell(1, 'z', 0, 0)).toBe(false);
      expect(Array.from(service.pendingMask(1, 'z')!)).toEqual([0, 0, 0, 0]);
    });

    it('refuses a rectangle that only covers already-zoned cells', () => {
      expect(service.selectRect(1, 'z', 0, 0, 1, 1)).toBe(false);
      expect(Array.from(service.pendingMask(1, 'z')!)).toEqual([0, 0, 0, 0]);
    });

    it('resetZones wipes the committed zone and lets the whole grid be painted again', () => {
      service.resetZones(1);

      expect(service.getSession(1)?.zones).toEqual([]);
      expect(service.coverage(1)).toEqual({ assigned: 0, total: 4 });
      expect(service.zoneIdAt(1, 0, 0, 0)).toBeNull();
      // The cell that was refused above (already zoned) is selectable again.
      expect(service.toggleCell(1, 'z', 0, 0)).toBe(true);
    });

    it('resetZones carries the zone-overlay opacity over, unlike everything else', () => {
      service.setZoneOverlayOpacity(1, 0.2);
      service.resetZones(1);
      expect(service.getZoneOverlayOpacity(1)).toBe(0.2);
    });
  });

  describe('zone-overlay opacity', () => {
    beforeEach(() => {
      statuses.set(1, { kind: 'ok', result: buildGrid(2, 2, 1) });
      service.open(1, fakeSource);
    });

    it('defaults to 0.75', () => {
      expect(service.getZoneOverlayOpacity(1)).toBe(0.75);
    });

    it('clamps to [0, 1]', () => {
      service.setZoneOverlayOpacity(1, 5);
      expect(service.getZoneOverlayOpacity(1)).toBe(1);
      service.setZoneOverlayOpacity(1, -2);
      expect(service.getZoneOverlayOpacity(1)).toBe(0);
    });
  });

  describe('setZoneColor', () => {
    beforeEach(() => {
      statuses.set(1, { kind: 'ok', result: buildGrid(2, 2, 1) });
      service.open(1, fakeSource);
      service.selectRect(1, 'x', 0, 0, 1, 0);
      service.selectRect(1, 'y', 0, 0, 1, 0);
      service.selectRect(1, 'z', 0, 0, 1, 1);
      service.finishZone(1);
    });

    it('overrides a zone color without touching which voxels belong to it', () => {
      service.setZoneColor(1, 0, '#123456');

      expect(service.getSession(1)?.zones[0].color).toBe('#123456');
      expect(service.getSession(1)?.zones[0].voxelCount).toBe(4);
      expect(service.zoneIdAt(1, 0, 0, 0)).toBe(0);
    });

    it('bumps zonesRevision on a color change (zones.length alone would not catch it)', () => {
      const before = service.zonesRevision(1);
      service.setZoneColor(1, 0, '#123456');
      expect(service.zonesRevision(1)).toBeGreaterThan(before);
    });

    it('does nothing for an unknown zone id', () => {
      const before = service.getSession(1)?.zones[0].color;
      service.setZoneColor(1, 99, '#123456');
      expect(service.getSession(1)?.zones[0].color).toBe(before);
    });
  });

  describe('viewState', () => {
    it('classifies a committed cell as zoned, and leaves the rest available once the pending masks reset (no constraint yet for the next zone)', () => {
      statuses.set(1, { kind: 'ok', result: buildGrid(2, 2, 1) });
      service.open(1, fakeSource);
      service.toggleCell(1, 'x', 0, 0);
      service.toggleCell(1, 'y', 0, 0);
      service.toggleCell(1, 'z', 0, 0);
      service.finishZone(1);

      const view = service.viewState(1, 'z');
      expect(view.cells[0]).toEqual({ kind: 'zoned', color: jasmine.any(String) });
      expect(view.cells[1]).toEqual({ kind: 'available' });
    });

    it('excludes a cell once the OTHER 2 views rule out every voxel it could contribute', () => {
      statuses.set(1, { kind: 'ok', result: buildGrid(2, 2, 1) });
      service.open(1, fakeSource);
      // x-view restricts to iy=0 only, y-view restricts to ix=0 only - so on
      // the z-view, only (ix=0, iy=0) can still contribute anything.
      service.toggleCell(1, 'x', 0, 0);
      service.toggleCell(1, 'y', 0, 0);

      const view = service.viewState(1, 'z');
      expect(view.cells[0]).toEqual({ kind: 'available' }); // (ix=0, iy=0)
      expect(view.cells[1]).toEqual({ kind: 'excluded' }); // (ix=1, iy=0)
      expect(view.cells[2]).toEqual({ kind: 'excluded' }); // (ix=0, iy=1)
      expect(view.cells[3]).toEqual({ kind: 'excluded' }); // (ix=1, iy=1)
    });
  });

  describe('save', () => {
    it('refuses to save while coverage is partial', () => {
      statuses.set(1, { kind: 'ok', result: buildGrid(2, 1, 1) });
      service.open(1, fakeSource);
      service.toggleCell(1, 'x', 0, 0);
      service.toggleCell(1, 'y', 0, 0);
      service.toggleCell(1, 'z', 0, 0);
      service.finishZone(1); // claims only (0,0,0) - the grid has 2 occupied cells

      expect(service.save(1)).toBe(false);
      expect(service.isSaved(1)).toBe(false);
    });

    it('saves once every occupied voxel is assigned to some zone', () => {
      statuses.set(1, { kind: 'ok', result: buildGrid(1, 1, 1) });
      service.open(1, fakeSource);
      service.toggleCell(1, 'x', 0, 0);
      service.toggleCell(1, 'y', 0, 0);
      service.toggleCell(1, 'z', 0, 0);
      service.finishZone(1);

      expect(service.save(1)).toBe(true);
      expect(service.isSaved(1)).toBe(true);
    });

    it('resetZones clears the saved flag along with the zones', () => {
      statuses.set(1, { kind: 'ok', result: buildGrid(1, 1, 1) });
      service.open(1, fakeSource);
      service.toggleCell(1, 'x', 0, 0);
      service.toggleCell(1, 'y', 0, 0);
      service.toggleCell(1, 'z', 0, 0);
      service.finishZone(1);
      service.save(1);

      service.resetZones(1);
      expect(service.isSaved(1)).toBe(false);
    });
  });

  describe('discarding a session when its reference changes', () => {
    it('drops the zone data once the source STL reference changes (rotate/move/re-import)', () => {
      statuses.set(1, { kind: 'ok', result: buildGrid(1, 1, 1) });
      service.open(1, fakeSource);
      service.toggleCell(1, 'x', 0, 0);
      service.toggleCell(1, 'y', 0, 0);
      service.toggleCell(1, 'z', 0, 0);
      service.finishZone(1);
      expect(service.getSession(1)?.zones.length).toBe(1);

      // Same event VoxelizationService itself reacts to in order to clear a
      // stale voxelization result - refreshScaledReference's own early-return
      // branch (no imported geometry set up here) still emits it.
      TestBed.inject(ImportedReferenceRenderService).refreshScaledReference(1);

      expect(service.getSession(1)).toBeNull();
    });

    it('closes the window if the discarded session was the one currently open', () => {
      statuses.set(1, { kind: 'ok', result: buildGrid(1, 1, 1) });
      service.open(1, fakeSource);
      expect(service.activeSessionId()).toBe(1);

      TestBed.inject(ImportedReferenceRenderService).refreshScaledReference(1);

      expect(service.activeSessionId()).toBeNull();
    });
  });
});