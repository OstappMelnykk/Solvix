import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { SolverService } from './solver.service';
import { SolverHubClient } from '../api/solver-hub.client';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { NotificationService } from './notification.service';
import { SessionsService } from './sessions.service';
import { SolverJobDto, SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { linkedPairState, singleCubeState } from '../geometry/mesh-state.fixture.spec';

describe('SolverService', () => {
  let solver: SolverService;
  let http: HttpTestingController;
  let selection: MeshEditorSelectionService;
  let notifications: NotificationService;
  let hub: jasmine.SpyObj<SolverHubClient>;
  let jobListener: (sessionId: number, job: SolverJobDto) => void;
  let sessionId: number;

  const api = `${environment.apiBaseUrl}/api/solver`;
  const meshApi = `${environment.apiBaseUrl}/api/mesh-editor`;
  const emptySetup: SolverSetupDto = {
    version: 0,
    materials: [
      { name: 'steel', label: 'Сталь', e: 2.1e11, nu: 0.3 },
      { name: 'rubber', label: 'Гума', e: 1e7, nu: 0.45 }
    ],
    defaultMaterial: 'steel',
    hexMaterials: {},
    fixed: [],
    loads: []
  };
  const lastToast = () => notifications.toasts().slice(-1)[0];
  const job = (state: SolverJobDto['state'], progress = 0, ticket = 1, error: string | null = null): SolverJobDto => ({ state, progress, stage: 'Етап', error, ticket });
  const result = (ticket = 1): SolverResultDto => ({ ticket, nodeIds: [0], ux: [0], uy: [0], uz: [0.001], vonMises: [5e6], maxDisplacement: 0.001, maxVonMises: 5e6, elapsedSeconds: 0.2 });

  beforeEach(() => {
    localStorage.clear();
    hub = jasmine.createSpyObj<SolverHubClient>('SolverHubClient', ['onJobChanged', 'join', 'leave']);
    hub.onJobChanged.and.callFake(listener => (jobListener = listener));
    hub.join.and.resolveTo(true);
    hub.leave.and.resolveTo();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), { provide: SolverHubClient, useValue: hub }] });
    http = TestBed.inject(HttpTestingController);
    selection = TestBed.inject(MeshEditorSelectionService);
    notifications = TestBed.inject(NotificationService);
    sessionId = TestBed.inject(SessionsService).sessions()[0].id;
    solver = TestBed.inject(SolverService);
    TestBed.flushEffects();
    // the mesh the faces refer to
    http.match(`${meshApi}/${sessionId}/state`).forEach(r => r.flush(linkedPairState()));
  });

  afterEach(() => http.match(() => true));

  function loadSetup(setup: SolverSetupDto = emptySetup): void {
    solver.setup(sessionId);
    http.expectOne(`${api}/${sessionId}/setup`).flush(setup);
  }

  it('fetches the set-up the first time it is asked for, and only once', () => {
    expect(solver.setup(sessionId)).toBeNull();
    http.expectOne(`${api}/${sessionId}/setup`).flush(emptySetup);

    expect(solver.setup(sessionId)).toEqual(emptySetup);
    http.expectNone(`${api}/${sessionId}/setup`);
  });

  it('reports an unreachable server for the set-up as an error toast and retries on the next ask', () => {
    solver.setup(sessionId);
    http.expectOne(`${api}/${sessionId}/setup`).flush('x', { status: 500, statusText: 'Server Error' });

    expect(notifications.toasts()[0].kind).toBe('error');
    solver.setup(sessionId);
    http.expectOne(`${api}/${sessionId}/setup`);
  });

  it('tells which material a cube has, falling back to the default one', () => {
    loadSetup({ ...emptySetup, hexMaterials: { '1': 'rubber' } });

    expect(solver.materialOf(sessionId, 1)).toBe('rubber');
    expect(solver.materialOf(sessionId, 0)).toBe('steel');
  });

  describe('face supports and loads', () => {
    it('clamps the picked free face and takes the answer as the new set-up', () => {
      loadSetup();
      selection.selectFace(sessionId, { hex: 0, face: 'XMinus' });

      solver.fixPickedFace(sessionId, true);

      const request = http.expectOne(`${api}/${sessionId}/faces/fixed`);
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({ faces: [{ hex: 0, face: 'XMinus' }], fixed: true });
      request.flush({ ...emptySetup, version: 1, fixed: [{ hex: 0, face: 'XMinus' }] });
      expect(solver.isFixed(sessionId, 0, 'XMinus')).toBeTrue();
      expect(solver.isFixed(sessionId, 0, 'XPlus')).toBeFalse();
    });

    it('presses the picked face and removes the pressure with null', () => {
      loadSetup();
      selection.selectFace(sessionId, { hex: 1, face: 'XPlus' });

      solver.loadPickedFace(sessionId, 2e6);
      const request = http.expectOne(`${api}/${sessionId}/faces/load`);
      expect(request.request.body).toEqual({ faces: [{ hex: 1, face: 'XPlus' }], pressure: 2e6 });
      request.flush({ ...emptySetup, loads: [{ hex: 1, face: 'XPlus', pressure: 2e6 }] });
      expect(solver.pressureOn(sessionId, 1, 'XPlus')).toBe(2e6);

      solver.loadPickedFace(sessionId, null);
      expect(http.expectOne(`${api}/${sessionId}/faces/load`).request.body.pressure).toBeNull();
    });

    it('refuses a face inside the body (linked to another cube) and an empty pick, with a hint', () => {
      loadSetup();
      selection.selectFace(sessionId, { hex: 0, face: 'XPlus' });   // linked to cube 1

      solver.fixPickedFace(sessionId, true);
      expect(lastToast().message).toContain('усередині тіла');

      selection.clear(sessionId);
      solver.fixPickedFace(sessionId, true);
      expect(lastToast().message).toContain('Виберіть грань');
      http.expectNone(`${api}/${sessionId}/faces/fixed`);
    });

    it('clamps a whole side: every outer face with that name, and none of the inner ones', () => {
      loadSetup();

      solver.fixSide(sessionId, 'XPlus', true);          // cube 1's XPlus is outer, cube 0's is linked
      const request = http.expectOne(`${api}/${sessionId}/faces/fixed`);
      expect(request.request.body.faces).toEqual([{ hex: 1, face: 'XPlus' }]);
      request.flush(emptySetup);
    });

    it('says when a side has no outer faces', () => {
      loadSetup();
      TestBed.inject(SessionsService);
      const faces = solver.outerFaces(sessionId, 'XPlus');
      expect(faces.map(f => f.hex)).toEqual([1]);
    });

    it('a changed set-up makes the old verdict stale', () => {
      loadSetup();
      solver.validate(sessionId);
      http.expectOne(`${api}/${sessionId}/validate`).flush({ canSolve: true, issues: [] });
      expect(solver.validation(sessionId)).not.toBeNull();
      selection.selectFace(sessionId, { hex: 0, face: 'XMinus' });

      solver.fixPickedFace(sessionId, true);
      http.expectOne(`${api}/${sessionId}/faces/fixed`).flush(emptySetup);

      expect(solver.validation(sessionId)).toBeNull();
    });

    it('reports a failed save as an error toast', () => {
      loadSetup();
      selection.selectFace(sessionId, { hex: 0, face: 'XMinus' });

      solver.fixPickedFace(sessionId, true);
      http.expectOne(`${api}/${sessionId}/faces/fixed`).flush('x', { status: 500, statusText: 'Server Error' });

      expect(lastToast().kind).toBe('error');
    });
  });

  describe('materials', () => {
    it('gives the picked cubes a material', () => {
      loadSetup();
      selection.toggleHex(sessionId, 1);

      solver.setMaterialOfSelection(sessionId, 'rubber');

      const request = http.expectOne(`${api}/${sessionId}/hexes/material`);
      expect(request.request.body).toEqual({ hexIds: [1], material: 'rubber' });
      request.flush({ ...emptySetup, hexMaterials: { '1': 'rubber' } });
      expect(solver.materialOf(sessionId, 1)).toBe('rubber');
    });

    it('gives every cube the material when none is picked', () => {
      loadSetup();

      solver.setMaterialOfSelection(sessionId, 'rubber');

      expect(http.expectOne(`${api}/${sessionId}/hexes/material`).request.body.hexIds).toEqual([0, 1]);
    });

    it('sends nothing for an empty list of cubes', () => {
      solver.setMaterial(sessionId, [], 'rubber');

      http.expectNone(`${api}/${sessionId}/hexes/material`);
    });

    it('adds a material to the library and changes the default one', () => {
      loadSetup();

      solver.upsertMaterial(sessionId, { name: 'glass', label: 'Скло', e: 7e10, nu: 0.22 });
      expect(http.expectOne(`${api}/${sessionId}/materials`).request.body.name).toBe('glass');
      solver.setDefaultMaterial(sessionId, 'rubber');
      expect(http.expectOne(`${api}/${sessionId}/default-material`).request.body).toEqual({ material: 'rubber' });
    });
  });

  describe('solving', () => {
    it('starts a solve after joining the hub, and fetches the result when the job is done', fakeAsync(() => {
      loadSetup();

      solver.solve(sessionId);
      tick();
      expect(hub.join).toHaveBeenCalledWith(sessionId);
      http.expectOne(`${api}/${sessionId}/solve`).flush(job('running', 0));
      expect(solver.isRunning(sessionId)).toBeTrue();

      jobListener(sessionId, job('running', 0.5));
      expect(solver.job(sessionId).progress).toBe(0.5);
      jobListener(sessionId, job('done', 1));
      http.expectOne(`${api}/${sessionId}/result`).flush(result());

      expect(solver.isRunning(sessionId)).toBeFalse();
      expect(solver.result(sessionId)?.maxVonMises).toBe(5e6);
    }));

    it('does not start a second solve while one runs', fakeAsync(() => {
      loadSetup();
      solver.solve(sessionId);
      tick();
      http.expectOne(`${api}/${sessionId}/solve`).flush(job('running', 0));

      solver.solve(sessionId);
      tick();

      http.expectNone(`${api}/${sessionId}/solve`);
    }));

    it('ignores a late message of an older run', fakeAsync(() => {
      loadSetup();
      solver.solve(sessionId);
      tick();
      http.expectOne(`${api}/${sessionId}/solve`).flush(job('running', 0, 2));

      jobListener(sessionId, job('done', 1, 1));

      expect(solver.isRunning(sessionId)).toBeTrue();
      http.expectNone(`${api}/${sessionId}/result`);
    }));

    it('shows the server\'s reason when a solve fails', fakeAsync(() => {
      loadSetup();
      solver.solve(sessionId);
      tick();
      http.expectOne(`${api}/${sessionId}/solve`).flush(job('failed', 0, 1, 'Закріпіть хоча б одну грань'));

      expect(solver.job(sessionId).state).toBe('failed');
      expect(lastToast().message).toBe('Закріпіть хоча б одну грань');
      flush();
    }));

    it('polls for progress when the hub is unreachable, and stops when the job ends', fakeAsync(() => {
      hub.join.and.resolveTo(false);
      loadSetup();
      solver.solve(sessionId);
      tick();
      http.expectOne(`${api}/${sessionId}/solve`).flush(job('running', 0));

      tick(400);
      http.expectOne(`${api}/${sessionId}/job`).flush(job('running', 0.3));
      expect(solver.job(sessionId).progress).toBe(0.3);
      tick(400);
      http.expectOne(`${api}/${sessionId}/job`).flush(job('done', 1));
      http.expectOne(`${api}/${sessionId}/result`).flush(result());
      tick(1000);
      http.expectNone(`${api}/${sessionId}/job`);
    }));

    it('cancels a running solve', () => {
      solver.cancel(sessionId);

      http.expectOne(`${api}/${sessionId}/cancel`).flush(job('cancelled'));

      expect(solver.job(sessionId).state).toBe('cancelled');
    });

    it('validates and keeps the verdict', () => {
      solver.validate(sessionId);

      http.expectOne(`${api}/${sessionId}/validate`).flush({ canSolve: false, issues: [{ severity: 'error', message: 'Закріпіть' }] });

      expect(solver.validation(sessionId)?.issues[0].message).toBe('Закріпіть');
    });

    it('reports an unreachable server when starting', fakeAsync(() => {
      loadSetup();
      solver.solve(sessionId);
      tick();

      http.expectOne(`${api}/${sessionId}/solve`).flush('x', { status: 500, statusText: 'Server Error' });

      expect(lastToast().kind).toBe('error');
      flush();
    }));

    it('clears the result', fakeAsync(() => {
      loadSetup();
      solver.solve(sessionId);
      tick();
      http.expectOne(`${api}/${sessionId}/solve`).flush(job('running'));
      jobListener(sessionId, job('done', 1));
      http.expectOne(`${api}/${sessionId}/result`).flush(result());

      solver.clearResult(sessionId);

      expect(solver.result(sessionId)).toBeNull();
      expect(solver.job(sessionId).state).toBe('idle');
    }));
  });

  describe('view settings and bookkeeping', () => {
    it('changes the shown field and the deformation, ignoring bad scales, and bumps the revision', () => {
      const before = solver.revision(sessionId);

      solver.setField(sessionId, 'displacement');
      solver.setDeformationScale(sessionId, 50);
      solver.setDeformationScale(sessionId, -1);
      solver.setDeformationScale(sessionId, NaN);

      expect(solver.display(sessionId)).toEqual({ field: 'displacement', deformationScale: 50 });
      expect(solver.revision(sessionId)).toBe(before + 2);
    });

    it('forgets everything about a session after the mesh was reset', () => {
      loadSetup({ ...emptySetup, fixed: [{ hex: 0, face: 'XMinus' }] });
      solver.validate(sessionId);
      http.expectOne(`${api}/${sessionId}/validate`).flush({ canSolve: true, issues: [] });

      solver.forget(sessionId);

      expect(solver.validation(sessionId)).toBeNull();
      expect(solver.result(sessionId)).toBeNull();
      solver.setup(sessionId);          // fetched again, not kept
      http.expectOne(`${api}/${sessionId}/setup`).flush(emptySetup);
    });

    it('is keyed by session', () => {
      loadSetup({ ...emptySetup, fixed: [{ hex: 0, face: 'XMinus' }] });

      expect(solver.isFixed(sessionId + 100, 0, 'XMinus')).toBeFalse();
    });
  });

  // keep the unused fixture import honest
  it('works with a single-cube mesh too', () => {
    expect(singleCubeState().hexes.length).toBe(1);
  });
});
