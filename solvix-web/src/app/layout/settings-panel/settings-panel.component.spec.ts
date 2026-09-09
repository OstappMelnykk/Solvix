import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import * as THREE from 'three';
import { SettingsPanelComponent } from './settings-panel.component';
import { SessionsService } from '../../state/sessions.service';
import { ImportedGeometryService } from '../../state/imported-geometry.service';
import { ModelImportService } from '../../geometry/model-import.service';

// A controllable stand-in for the real load - lets a test hold a "file
// import in flight" open across other actions (switching/closing sessions)
// instead of racing against however fast the real GLTFLoader/STLLoader
// actually resolve.
class FakeModelImportService {
  readonly loads = new Subject<THREE.Object3D>();

  loadFromFile(): Subject<THREE.Object3D> {
    return this.loads;
  }

  getAcceptedExtensions(): string {
    return '.glb';
  }
}

function meshObject(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  return group;
}

function fileChangeEvent(name: string): Event {
  const input = document.createElement('input');
  input.type = 'file';
  Object.defineProperty(input, 'files', { value: [new File([], name)] });
  return { target: input } as unknown as Event;
}

describe('SettingsPanelComponent import race conditions', () => {
  let sessions: SessionsService;
  let importedGeometry: ImportedGeometryService;
  let fakeImport: FakeModelImportService;
  let fixture: ComponentFixture<SettingsPanelComponent>;
  let component: SettingsPanelComponent;

  beforeEach(() => {
    fakeImport = new FakeModelImportService();
    TestBed.configureTestingModule({
      providers: [{ provide: ModelImportService, useValue: fakeImport }, provideHttpClient(), provideHttpClientTesting()]
    });
    sessions = TestBed.inject(SessionsService);
    importedGeometry = TestBed.inject(ImportedGeometryService);
    fixture = TestBed.createComponent(SettingsPanelComponent);
    component = fixture.componentInstance;
    // The constructor's sessionId()-watching effect is tied to this
    // component's own view - detectChanges() is what actually runs it (not
    // TestBed.flushEffects(), which only reaches root-injector-scoped
    // effects like the ones in the *.service.spec.ts files), both for this
    // initial baseline and again after any later signal change in a test.
    fixture.detectChanges();
  });

  it('does not clobber a DIFFERENT session\'s status when an in-flight import for a stale session resolves', () => {
    const first = sessions.sessions()[0].id;
    component.onImportFile(fileChangeEvent('model.glb'));

    // Switch away before the load resolves - the session the load started
    // for is no longer the active one. detectChanges() mirrors what a real
    // change-detection cycle already does automatically: the constructor's
    // sessionId()-watching effect resets transientStatus to 'idle' for the
    // newly active session.
    sessions.createSession();
    fixture.detectChanges();
    const second = sessions.sessions()[1].id;
    expect(sessions.activeSessionId()).toBe(second);

    fakeImport.loads.next(meshObject());
    fakeImport.loads.complete();

    // The now-active session never imported anything - its status must
    // stay 'none', not flip to 'success'/'idle' because of session A's load.
    expect(component.getImportDisplayStatus()).toEqual({ kind: 'none' });
    // But the load itself still lands on the session it was actually for.
    expect(importedGeometry.get(first)).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('disposes the loaded object instead of resurrecting a session that was closed mid-load', () => {
    const first = sessions.sessions()[0].id;
    component.onImportFile(fileChangeEvent('model.glb'));

    sessions.closeSession(first);
    fixture.detectChanges();

    const object = meshObject();
    const mesh = object.children[0] as THREE.Mesh;
    const geometryDispose = spyOn(mesh.geometry, 'dispose');

    fakeImport.loads.next(object);
    fakeImport.loads.complete();

    expect(importedGeometry.get(first)).toBeNull();
    expect(geometryDispose).toHaveBeenCalled();
  });

  it('still updates status normally when the session is still active when the load resolves', () => {
    component.onImportFile(fileChangeEvent('model.glb'));
    fakeImport.loads.next(meshObject());
    fakeImport.loads.complete();

    expect(component.getImportDisplayStatus().kind).toBe('success');
  });
});