import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import * as THREE from 'three';
import { ZoneListComponent } from './zone-list.component';
import { ZonePaintingService, ZonePaintingSource } from '../../state/zone-painting.service';
import { SurfaceZonePaintingService, SurfaceZonePaintingSource } from '../../state/surface-zone-painting.service';
import { SessionsService } from '../../state/sessions.service';
import { VoxelizationService, VoxelizationStatus } from '../../state/voxelization.service';
import { ImportedReferenceRenderService } from '../../state/imported-reference-render.service';
import { VoxelGridDto } from '../../geometry/voxel-grid-contract';

function buildVoxelGrid(countX: number, countY: number, countZ: number): VoxelGridDto {
  const occupancy = new Uint8Array(Math.ceil((countX * countY * countZ) / 8)).fill(0xff);
  return { origin: { x: 0, y: 0, z: 0 }, cellSize: 1, countX, countY, countZ, occupancy };
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

// The exact "went to step 2, never finished it, came back" scenario
// reported live: a zone that has voxels but ZERO committed STL cells.
describe('ZoneListComponent', () => {
  let fixture: ComponentFixture<ZoneListComponent>;
  let zonePainting: ZonePaintingService;
  let surfaceZonePainting: SurfaceZonePaintingService;
  let referenceRender: ImportedReferenceRenderService;
  let statuses: Map<number, VoxelizationStatus>;

  beforeEach(() => {
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

  it('shows an empty list before any zone exists', () => {
    expect(zoneRows().length).toBe(0);
    expect(fixture.nativeElement.querySelector('.zone-list__empty')).toBeTruthy();
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
});
