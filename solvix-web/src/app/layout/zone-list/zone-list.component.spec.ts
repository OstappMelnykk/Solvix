import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import * as THREE from 'three';
import { ZoneListComponent } from './zone-list.component';
import { ZonePaintingService, ZonePaintingSource } from '../../state/zone-painting.service';
import { SurfaceZonePaintingService, SurfaceZonePaintingSource, SurfaceZoneCellState } from '../../state/surface-zone-painting.service';
import { SessionsService } from '../../state/sessions.service';
import { VoxelizationService, VoxelizationStatus } from '../../state/voxelization.service';
import { ImportedReferenceRenderService } from '../../state/imported-reference-render.service';
import { VoxelGridDto } from '../../geometry/voxel-grid-contract';

function buildVoxelGrid(countX: number, countY: number, countZ: number): VoxelGridDto {
  const occupancy = new Uint8Array(Math.ceil((countX * countY * countZ) / 8)).fill(0xff);
  return { origin: { x: 0, y: 0, z: 0 }, cellSize: 1, countX, countY, countZ, occupancy, markedForRefinement: new Uint8Array(occupancy.length) };
}

function meshFromTriangles(positions: number[]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

const fakeZonePaintingSource: ZonePaintingSource = {
  scene: new THREE.Scene(),
  voxelPreview: new THREE.Object3D(),
  stlMesh: null,
  framingObjects: [],
  hiddenDuringView: []
};

function buildSurfaceSource(): SurfaceZonePaintingSource {
  return {
    scene: new THREE.Scene(),
    stlMesh: meshFromTriangles([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    framingObjects: [],
    hiddenDuringView: [],
    step1Source: fakeZonePaintingSource
  };
}

function firstAvailableCell(view: { width: number; height: number; cells: SurfaceZoneCellState[] }): { u: number; v: number } | null {
  for (let v = 0; v < view.height; v++) {
    for (let u = 0; u < view.width; u++) {
      if (view.cells[u + v * view.width].kind === 'available') {
        return { u, v };
      }
    }
  }
  return null;
}

// The exact "went to step 2, never finished it, came back" scenario
// reported live: a zone that has voxels but ZERO committed STL cells.
describe('ZoneListComponent', () => {
  let fixture: ComponentFixture<ZoneListComponent>;
  let component: ZoneListComponent;
  let zonePainting: ZonePaintingService;
  let surfaceZonePainting: SurfaceZonePaintingService;
  let referenceRender: ImportedReferenceRenderService;
  let statuses: Map<number, VoxelizationStatus>;

  beforeEach(() => {
    // ZonePaintingStorageService/SurfaceZonePaintingStorageService now
    // persist to real localStorage (reload-survival - see
    // [[project_model_persistence]]), which otherwise leaks between
    // tests/spec files in this same browser instance.
    localStorage.clear();
    statuses = new Map();
    statuses.set(1, { kind: 'ok', result: buildVoxelGrid(3, 1, 1) });
    TestBed.configureTestingModule({
      imports: [ZoneListComponent],
      providers: [
        { provide: SessionsService, useValue: { sessions: signal([{ id: 1 }]) } },
        { provide: VoxelizationService, useValue: { getStatus: (id: number) => statuses.get(id) ?? { kind: 'idle' } } }
      ]
    });
    zonePainting = TestBed.inject(ZonePaintingService);
    surfaceZonePainting = TestBed.inject(SurfaceZonePaintingService);
    referenceRender = TestBed.inject(ImportedReferenceRenderService);
    spyOn(referenceRender, 'getScaledReference').and.returnValue(meshFromTriangles([0, 0, 0, 1, 0, 0, 0, 1, 0]));

    zonePainting.open(1, fakeZonePaintingSource);
    fixture = TestBed.createComponent(ZoneListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  function zoneRows(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.zone-list__zone-row'));
  }

  function editButtonIn(row: HTMLElement): HTMLButtonElement | undefined {
    return Array.from(row.querySelectorAll('button')).find(btn => btn.textContent?.trim() === 'Редагувати') as HTMLButtonElement | undefined;
  }

  function confirmYesButtonIn(row: HTMLElement): HTMLButtonElement | undefined {
    return Array.from(row.querySelectorAll('button')).find(btn => btn.textContent?.trim() === 'Так') as HTMLButtonElement | undefined;
  }

  function confirmNoButtonIn(row: HTMLElement): HTMLButtonElement | undefined {
    return Array.from(row.querySelectorAll('button')).find(btn => btn.textContent?.trim() === 'Ні') as HTMLButtonElement | undefined;
  }

  function deleteButtonIn(row: HTMLElement): HTMLButtonElement | undefined {
    return Array.from(row.querySelectorAll('button')).find(btn => btn.textContent?.trim() === 'Видалити') as HTMLButtonElement | undefined;
  }

  function colorInputIn(row: HTMLElement): HTMLInputElement | null {
    return row.querySelector('input[type="color"]');
  }

  function zoneStatsTextIn(row: HTMLElement): string {
    return row.querySelector('.zone-list__zone-stats')?.textContent?.trim() ?? '';
  }

  it('shows an empty list before any zone exists', () => {
    expect(zoneRows().length).toBe(0);
  });

  it('shows "Редагувати" on the last zone even when it has 0 STL cells (step 2 was opened but never finished)', () => {
    // Zone 0: voxels only, matching the reported "Вокселі: N / M, STL: 0 / K" state.
    zonePainting.toggleCell(1, 'y', 0, 0);
    zonePainting.finishZone(1);

    // Step 2 gets opened for it (as the wizard's own hand-off does) but the
    // user never calls finishSelection - 0 STL cells, exactly as reported.
    const source: SurfaceZonePaintingSource = {
      scene: new THREE.Scene(),
      stlMesh: meshFromTriangles([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      framingObjects: [],
      hiddenDuringView: [],
      step1Source: fakeZonePaintingSource
    };
    surfaceZonePainting.open(1, source);
    surfaceZonePainting.setActiveVoxelZoneId(1, 0);
    surfaceZonePainting.close(); // "Закрити" without ever finishing

    fixture.detectChanges();

    const rows = zoneRows();
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('0 ділянок STL');
    const editButton = editButtonIn(rows[0]);
    expect(editButton).withContext('the last zone should always show a Редагувати button').not.toBeUndefined();
  });

  it('clicking "Редагувати" shows an inline "Так/Ні" prompt instead of acting immediately', () => {
    zonePainting.toggleCell(1, 'y', 0, 0);
    zonePainting.finishZone(1);
    fixture.detectChanges();

    editButtonIn(zoneRows()[0])!.click();
    fixture.detectChanges();

    // Not yet touched - only the prompt appeared.
    expect(zonePainting.getSession(1)?.zones.length).toBe(1);
    expect(zonePainting.step1Visible()).toBe(false);
    expect(confirmYesButtonIn(zoneRows()[0])).not.toBeUndefined();
  });

  it('confirming "Так" on the edit prompt deletes the zone and reopens step 1', () => {
    zonePainting.toggleCell(1, 'y', 0, 0);
    zonePainting.finishZone(1);
    fixture.detectChanges();

    editButtonIn(zoneRows()[0])!.click();
    fixture.detectChanges();
    confirmYesButtonIn(zoneRows()[0])!.click();

    expect(zonePainting.getSession(1)?.zones.length).toBe(0);
    expect(zonePainting.step1Visible()).toBe(true);
  });

  it('dismissing the edit prompt with "Ні" leaves the zone untouched', () => {
    zonePainting.toggleCell(1, 'y', 0, 0);
    zonePainting.finishZone(1);
    fixture.detectChanges();

    editButtonIn(zoneRows()[0])!.click();
    fixture.detectChanges();
    confirmNoButtonIn(zoneRows()[0])!.click();
    fixture.detectChanges();

    expect(zonePainting.getSession(1)?.zones.length).toBe(1);
    expect(zonePainting.step1Visible()).toBe(false);
    // Back to the normal row, not still showing the prompt.
    expect(editButtonIn(zoneRows()[0])).not.toBeUndefined();
  });

  it('does not show "Редагувати" on a non-last zone', () => {
    zonePainting.toggleCell(1, 'y', 0, 0);
    zonePainting.finishZone(1);
    zonePainting.toggleCell(1, 'y', 1, 0);
    zonePainting.finishZone(1);
    fixture.detectChanges();

    const rows = zoneRows();
    expect(rows.length).toBe(2);
    expect(editButtonIn(rows[0])).toBeUndefined();
    expect(editButtonIn(rows[1])).not.toBeUndefined();
  });

  describe('deleting a zone', () => {
    beforeEach(() => {
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1); // zone 0: ix=0
      zonePainting.toggleCell(1, 'y', 1, 0);
      zonePainting.finishZone(1); // zone 1: ix=1
      fixture.detectChanges();
    });

    it('clicking "Видалити" shows the inline Так/Ні prompt instead of acting immediately', () => {
      const rows = zoneRows();
      deleteButtonIn(rows[0])!.click();
      fixture.detectChanges();

      expect(zonePainting.getSession(1)?.zones.length).toBe(2); // untouched
      expect(confirmYesButtonIn(zoneRows()[0])).not.toBeUndefined();
    });

    it('dismissing the delete prompt with "Ні" leaves the zone untouched', () => {
      const rows = zoneRows();
      deleteButtonIn(rows[0])!.click();
      fixture.detectChanges();
      confirmNoButtonIn(zoneRows()[0])!.click();
      fixture.detectChanges();

      expect(zonePainting.getSession(1)?.zones.length).toBe(2);
      expect(deleteButtonIn(zoneRows()[0])).not.toBeUndefined(); // back to the normal row
    });

    it('confirming "Так" removes the zone and frees its voxels back to available', () => {
      deleteButtonIn(zoneRows()[0])!.click();
      fixture.detectChanges();
      confirmYesButtonIn(zoneRows()[0])!.click();
      fixture.detectChanges();

      expect(zonePainting.getSession(1)?.zones.length).toBe(1);
      expect(zonePainting.coverage(1)).toEqual({ assigned: 1, total: 3 }); // only the remaining zone's 1 voxel
      // The freed cell (ix=0) is available again, not stuck excluded.
      expect(zonePainting.viewState(1, 'y').cells[0].kind).toBe('available');
    });

    it('deleting a non-last zone renumbers every zone after it to stay contiguous', () => {
      // zone 0 (ix=0) is not the last - deleting it must renumber zone 1 (ix=1) down to id 0.
      deleteButtonIn(zoneRows()[0])!.click();
      fixture.detectChanges();
      confirmYesButtonIn(zoneRows()[0])!.click();
      fixture.detectChanges();

      const remaining = zonePainting.getSession(1)!.zones;
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe(0);
      expect(zonePainting.zoneIdAt(1, 1, 0, 0)).toBe(0); // the ix=1 voxel now belongs to renumbered zone 0
      expect(zoneRows()[0].textContent).toContain('Зона 1'); // the list's own 1-based label for id 0
    });

    it('deleting also frees any STL cells that zone had already painted', () => {
      const source = buildSurfaceSource();
      surfaceZonePainting.open(1, source);
      surfaceZonePainting.setActiveVoxelZoneId(1, 0);
      const cell = firstAvailableCell(surfaceZonePainting.viewState(1, 'y'))!;
      expect(cell).toBeTruthy();
      surfaceZonePainting.toggleCell(1, 'y', cell.u, cell.v);
      const { assigned } = surfaceZonePainting.finishSelection(1);
      expect(assigned).toBeGreaterThan(0);
      surfaceZonePainting.close();
      fixture.detectChanges();

      expect(surfaceZonePainting.cellCountForZone(1, 0)).toBe(assigned);

      deleteButtonIn(zoneRows()[0])!.click();
      fixture.detectChanges();
      confirmYesButtonIn(zoneRows()[0])!.click();
      fixture.detectChanges();

      // Zone 0's STL cells are gone, not just its voxels - and the
      // remaining (renumbered) zone 0 still shows 0, since it never
      // painted any STL itself.
      expect(surfaceZonePainting.coverage(1)!.assigned).toBe(0);
      expect(zoneRows()[0].textContent).toContain('0 ділянок STL');
    });

    it('opening the delete prompt on another row replaces (not stacks with) an already-open prompt', () => {
      const rows = zoneRows();
      deleteButtonIn(rows[0])!.click();
      fixture.detectChanges();
      expect(confirmYesButtonIn(zoneRows()[0])).not.toBeUndefined();

      deleteButtonIn(zoneRows()[1])!.click();
      fixture.detectChanges();

      // Row 0 is back to normal; only row 1 shows the prompt now.
      expect(deleteButtonIn(zoneRows()[0])).not.toBeUndefined();
      expect(confirmYesButtonIn(zoneRows()[1])).not.toBeUndefined();
    });
  });

  describe('editing the last zone frees its STL data too', () => {
    it('confirming edit clears both the voxel zone and any STL cells it had painted', () => {
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1);
      const source = buildSurfaceSource();
      surfaceZonePainting.open(1, source);
      surfaceZonePainting.setActiveVoxelZoneId(1, 0);
      const cell = firstAvailableCell(surfaceZonePainting.viewState(1, 'y'))!;
      surfaceZonePainting.toggleCell(1, 'y', cell.u, cell.v);
      const { assigned } = surfaceZonePainting.finishSelection(1);
      expect(assigned).toBeGreaterThan(0);
      surfaceZonePainting.close();
      fixture.detectChanges();

      editButtonIn(zoneRows()[0])!.click();
      fixture.detectChanges();
      confirmYesButtonIn(zoneRows()[0])!.click();

      expect(zonePainting.getSession(1)?.zones.length).toBe(0);
      expect(surfaceZonePainting.coverage(1)!.assigned).toBe(0);
      expect(zonePainting.step1Visible()).toBe(true);
    });
  });

  describe('requestEdit/performEdit guard against a non-last zone directly (defense in depth beyond the template *ngIf)', () => {
    it('requestEdit is a no-op on a non-last zone even if called directly', () => {
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1);
      zonePainting.toggleCell(1, 'y', 1, 0);
      zonePainting.finishZone(1);

      component.requestEdit(0); // zone 0 is no longer the last zone
      fixture.detectChanges();

      expect(component.isConfirming(0, 'edit')).toBe(false);
      expect(zonePainting.getSession(1)?.zones.length).toBe(2); // untouched
    });
  });

  describe('color picker', () => {
    beforeEach(() => {
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1);
      zonePainting.toggleCell(1, 'y', 1, 0);
      zonePainting.finishZone(1);
      fixture.detectChanges();
    });

    it('accepts a color not used by any other zone', () => {
      const row = zoneRows()[0];
      const input = colorInputIn(row)!;
      input.value = '#123456';
      input.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      expect(zonePainting.getSession(1)?.zones[0].color).toBe('#123456');
    });

    it('refuses a color already used by another zone and shows an error toast, leaving the color unchanged', () => {
      const zones = zonePainting.getSession(1)!.zones;
      const takenColor = zones[1].color;
      const originalColor = zones[0].color;
      const row = zoneRows()[0];
      const input = colorInputIn(row)!;
      input.value = takenColor;
      input.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      expect(zonePainting.getSession(1)?.zones[0].color).toBe(originalColor);
    });
  });

  describe('canAddZone / addZone gating once every voxel is claimed', () => {
    it('allows adding a zone while occupied voxels remain unclaimed', () => {
      expect(component.canAddZone()).toBe(true);
      expect(component.addZoneDisabledReason()).toBeNull();
    });

    it('disables adding once every occupied voxel belongs to some zone', () => {
      zonePainting.selectRect(1, 'y', 0, 0, 2, 0); // all 3 cells of the 3x1x1 grid
      zonePainting.finishZone(1);
      fixture.detectChanges();

      expect(zonePainting.coverage(1)).toEqual({ assigned: 3, total: 3 });
      expect(component.canAddZone()).toBe(false);
      expect(component.addZoneDisabledReason()).toBe('Усі вокселі вже розподілені по зонах.');

      const addButton = fixture.nativeElement.querySelector('.zone-list__add') as HTMLButtonElement;
      expect(addButton.disabled).toBe(true);
    });

    it('addZone is a no-op once coverage is already 100%, even if called directly', () => {
      zonePainting.selectRect(1, 'y', 0, 0, 2, 0);
      zonePainting.finishZone(1);

      component.addZone();

      expect(zonePainting.step1Visible()).toBe(false);
    });

    it('re-enables once a fresh voxelization gives the grid more unclaimed cells', () => {
      zonePainting.selectRect(1, 'y', 0, 0, 2, 0);
      zonePainting.finishZone(1);
      fixture.detectChanges();
      expect(component.canAddZone()).toBe(false);

      statuses.set(1, { kind: 'ok', result: buildVoxelGrid(3, 1, 1) }); // a fresh grid, re-voxelized
      zonePainting.close();
      surfaceZonePainting.close();
      zonePainting.open(1, fakeZonePaintingSource);
      fixture.detectChanges();

      expect(component.canAddZone()).toBe(true);
    });
  });

  describe('progress bar text and percent (voxels)', () => {
    it('starts at 0/total and 0% before any zone is painted', () => {
      expect(component.voxelCoverageText()).toBe('Вокселі: 0 / 3');
      expect(component.voxelCoveragePercent()).toBe(0);
    });

    it('rounds down at a third (1/3 -> 33%)', () => {
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1);
      fixture.detectChanges();

      expect(component.voxelCoverageText()).toBe('Вокселі: 1 / 3');
      expect(component.voxelCoveragePercent()).toBe(33);
    });

    it('rounds up at two thirds (2/3 -> 67%)', () => {
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1);
      zonePainting.toggleCell(1, 'y', 1, 0);
      zonePainting.finishZone(1);
      fixture.detectChanges();

      expect(component.voxelCoveragePercent()).toBe(67);
    });

    it('reaches exactly 100% once every occupied voxel is claimed by some zone', () => {
      zonePainting.selectRect(1, 'y', 0, 0, 2, 0);
      zonePainting.finishZone(1);
      fixture.detectChanges();

      expect(component.voxelCoverageText()).toBe('Вокселі: 3 / 3');
      expect(component.voxelCoveragePercent()).toBe(100);
    });

    it('shows the sum of every zone\'s own count in each row\'s own stats line', () => {
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1);
      fixture.detectChanges();

      expect(zoneStatsTextIn(zoneRows()[0])).toBe('1 вокселів · 0 ділянок STL');
    });
  });

  describe('progress bar text and percent (STL)', () => {
    it('shows "ще немає даних" and 0% before step 2 has ever opened for this session', () => {
      expect(component.stlCoverageText()).toBe('STL-поверхня: ще немає даних');
      expect(component.stlCoveragePercent()).toBe(0);
    });

    it('reports real counts and rounds the same way once a session exists', () => {
      zonePainting.toggleCell(1, 'y', 0, 0);
      zonePainting.finishZone(1);
      const source = buildSurfaceSource();
      surfaceZonePainting.open(1, source);
      surfaceZonePainting.setActiveVoxelZoneId(1, 0);
      const total = surfaceZonePainting.coverage(1)!.total;
      const cell = firstAvailableCell(surfaceZonePainting.viewState(1, 'y'))!;
      surfaceZonePainting.toggleCell(1, 'y', cell.u, cell.v);
      const { assigned } = surfaceZonePainting.finishSelection(1);
      fixture.detectChanges();

      expect(component.stlCoverageText()).toBe(`STL-поверхня: ${assigned} / ${total}`);
      expect(component.stlCoveragePercent()).toBe(Math.round((assigned / total) * 100));
    });

    it('returns to "ще немає даних" once the whole zone feature is closed (no active session at all)', () => {
      component.close();
      fixture.detectChanges();

      expect(component.stlCoverageText()).toBe('STL-поверхня: ще немає даних');
      expect(component.stlCoveragePercent()).toBe(0);
      expect(component.voxelCoverageText()).toBe('');
      expect(component.voxelCoveragePercent()).toBe(0);
    });
  });
});
