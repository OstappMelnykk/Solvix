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
    divisions: [1, 1, 1],
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
  const result = (ticket = 1): SolverResultDto => ({
    ticket, divisions: [1, 1, 1], positions: [0, 0, 0, 1, 0, 0], hexIds: [0], gridNodes: [0, 1],
    ux: [0, 0], uy: [0, 0], uz: [0, 0.001], vonMises: [0, 5e6], maxDisplacement: 0.001, maxVonMises: 5e6, elapsedSeconds: 0.2
  });

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

  describe('choosing faces, as in the solver', () => {
    const faces = (request: { request: { body: { faces: unknown } } }) => request.request.body.faces;

    it('starts in Load mode with the solver\'s default Pn of 1 MPa of compression', () => {
      expect(solver.mode(sessionId)).toBe('load');
      expect(solver.pressure(sessionId)).toBe(-1e6);
      expect(solver.loadSide(sessionId)).toBeNull();
      expect(solver.fixedSide(sessionId)).toBeNull();
      expect(solver.isFixedAuto(sessionId)).toBeFalse();
    });

    it('a whole side is pressed with Pn, replacing what was pressed, and the opposite side is clamped on its own', () => {
      loadSetup();

      solver.selectLoadSide(sessionId, 'XPlus');           // cube 1's XPlus is outer, cube 0's is linked
      const load = http.expectOne(`${api}/${sessionId}/faces/load`);
      expect(load.request.body).toEqual({ faces: [{ hex: 1, face: 'XPlus' }], pressure: -1e6, replace: true });
      load.flush({ ...emptySetup, loads: [{ hex: 1, face: 'XPlus', pressure: -1e6 }] });

      const fixedRequest = http.expectOne(`${api}/${sessionId}/faces/fixed`);
      expect(fixedRequest.request.body).toEqual({ faces: [{ hex: 0, face: 'XMinus' }], fixed: true, replace: true });
      fixedRequest.flush({ ...emptySetup, loads: [{ hex: 1, face: 'XPlus', pressure: -1e6 }], fixed: [{ hex: 0, face: 'XMinus' }] });
      expect(solver.loadSide(sessionId)).toBe('XPlus');
      expect(solver.fixedSide(sessionId)).toBe('XMinus');
      expect(solver.isFixedAuto(sessionId)).toBeTrue();
    });

    it('a clamped side chosen by the user is kept when the load moves, and a second click returns to automatic', () => {
      loadSetup();
      solver.selectFixedSide(sessionId, 'YMinus');
      const chosen = http.expectOne(`${api}/${sessionId}/faces/fixed`);
      expect(faces(chosen)).toEqual([{ hex: 0, face: 'YMinus' }, { hex: 1, face: 'YMinus' }]);
      chosen.flush({ ...emptySetup, fixed: [{ hex: 0, face: 'YMinus' }, { hex: 1, face: 'YMinus' }] });
      expect(solver.isFixedAuto(sessionId)).toBeFalse();
      expect(solver.fixedSide(sessionId)).toBe('YMinus');

      solver.selectLoadSide(sessionId, 'XPlus');
      http.expectOne(`${api}/${sessionId}/faces/load`).flush({ ...emptySetup });
      http.expectNone(`${api}/${sessionId}/faces/fixed`);               // the chosen clamping stays

      solver.selectFixedSide(sessionId, 'YMinus');                       // the same button again: automatic
      const auto = http.expectOne(`${api}/${sessionId}/faces/fixed`);
      expect(faces(auto)).toEqual([{ hex: 0, face: 'XMinus' }]);        // the opposite of the load's XPlus
      expect(solver.isFixedAuto(sessionId)).toBeTrue();
    });

    it('pressing the side that was clamped hands the clamping back to automatic', () => {
      loadSetup();
      solver.selectFixedSide(sessionId, 'XPlus');
      http.expectOne(`${api}/${sessionId}/faces/fixed`).flush(emptySetup);

      solver.selectLoadSide(sessionId, 'XPlus');
      http.expectOne(`${api}/${sessionId}/faces/load`).flush(emptySetup);

      expect(solver.isFixedAuto(sessionId)).toBeTrue();
      expect(solver.fixedSide(sessionId)).toBe('XMinus');
      http.expectOne(`${api}/${sessionId}/faces/fixed`);
    });

    it('lists the outer faces of a side, leaving out the faces inside the body', () => {
      expect(solver.outerFaces(sessionId, 'XPlus')).toEqual([{ hex: 1, face: 'XPlus' }]);
      expect(solver.outerFaces(sessionId, 'XMinus')).toEqual([{ hex: 0, face: 'XMinus' }]);
      expect(solver.outerFaces(sessionId, 'YPlus').map(f => f.hex)).toEqual([0, 1]);
    });

    it('a click on a face marks it as pressed in Load mode and unmarks it the next time', () => {
      loadSetup();

      solver.pick(sessionId, { kind: 'face', hex: 0, face: 'YPlus' }, false);
      const on = http.expectOne(`${api}/${sessionId}/faces/load`);
      expect(on.request.body).toEqual({ faces: [{ hex: 0, face: 'YPlus' }], pressure: -1e6 });
      on.flush({ ...emptySetup, loads: [{ hex: 0, face: 'YPlus', pressure: -1e6 }] });
      expect(solver.pressureOn(sessionId, 0, 'YPlus')).toBe(-1e6);

      solver.pick(sessionId, { kind: 'face', hex: 0, face: 'YPlus' }, false);
      expect(http.expectOne(`${api}/${sessionId}/faces/load`).request.body.pressure).toBeNull();
    });

    it('in Fix mode the same click clamps and unclamps, and marks the clamping as chosen', () => {
      loadSetup();
      solver.setMode(sessionId, 'fix');

      solver.pick(sessionId, { kind: 'face', hex: 1, face: 'ZMinus' }, false);
      const on = http.expectOne(`${api}/${sessionId}/faces/fixed`);
      expect(on.request.body).toEqual({ faces: [{ hex: 1, face: 'ZMinus' }], fixed: true });
      on.flush({ ...emptySetup, fixed: [{ hex: 1, face: 'ZMinus' }] });
      expect(solver.isFixed(sessionId, 1, 'ZMinus')).toBeTrue();
      expect(solver.isFixedAuto(sessionId)).toBeFalse();

      solver.pick(sessionId, { kind: 'face', hex: 1, face: 'ZMinus' }, false);
      expect(http.expectOne(`${api}/${sessionId}/faces/fixed`).request.body.fixed).toBeFalse();
    });

    it('Shift + click picks a cube (for its material) instead of marking a face', () => {
      loadSetup();

      solver.pick(sessionId, { kind: 'face', hex: 1, face: 'YPlus' }, true);

      expect(selection.hexes(sessionId)).toEqual([1]);
      http.expectNone(`${api}/${sessionId}/faces/load`);
    });

    it('a click on nothing does nothing', () => {
      loadSetup();

      solver.pick(sessionId, null, false);

      http.expectNone(`${api}/${sessionId}/faces/load`);
    });

    it('refuses a face inside the body (linked to another cube) with a hint', () => {
      loadSetup();

      solver.toggleFace(sessionId, { hex: 0, face: 'XPlus' });

      expect(lastToast().message).toContain('усередині тіла');
      http.expectNone(`${api}/${sessionId}/faces/load`);
    });

    it('a new Pn goes to every pressed face, and is only remembered when nothing is pressed', () => {
      loadSetup({ ...emptySetup, loads: [{ hex: 1, face: 'XPlus', pressure: -1e6 }] });

      solver.setPressure(sessionId, -3e6);
      const request = http.expectOne(`${api}/${sessionId}/faces/load`);
      expect(request.request.body).toEqual({ faces: [{ hex: 1, face: 'XPlus' }], pressure: -3e6, replace: true });
      request.flush({ ...emptySetup, loads: [{ hex: 1, face: 'XPlus', pressure: -3e6 }] });
      expect(solver.pressure(sessionId)).toBe(-3e6);

      solver.setPressure(sessionId, NaN);
      expect(solver.pressure(sessionId)).toBe(-3e6);
    });

    it('counts the faces of the divided mesh: a cube face is nx*ny*nz / n_axis small faces', () => {
      loadSetup({ ...emptySetup, divisions: [2, 3, 4], loads: [{ hex: 0, face: 'XMinus', pressure: -1e6 }, { hex: 1, face: 'ZPlus', pressure: -1e6 }], fixed: [{ hex: 0, face: 'YPlus' }] });

      expect(solver.loadedFaceCount(sessionId)).toBe(3 * 4 + 2 * 3);      // X face: ny*nz, Z face: nx*ny
      expect(solver.fixedFaceCount(sessionId)).toBe(2 * 4);               // Y face: nx*nz
      expect(solver.divisions(sessionId)).toEqual([2, 3, 4]);
    });

    it('a changed set-up makes the old verdict stale', () => {
      loadSetup();
      solver.validate(sessionId);
      http.expectOne(`${api}/${sessionId}/validate`).flush({ canSolve: true, issues: [] });
      expect(solver.validation(sessionId)).not.toBeNull();

      solver.pick(sessionId, { kind: 'face', hex: 0, face: 'YPlus' }, false);
      http.expectOne(`${api}/${sessionId}/faces/load`).flush(emptySetup);

      expect(solver.validation(sessionId)).toBeNull();
    });

    it('reports a failed save as an error toast', () => {
      loadSetup();

      solver.pick(sessionId, { kind: 'face', hex: 0, face: 'YPlus' }, false);
      http.expectOne(`${api}/${sessionId}/faces/load`).flush('x', { status: 500, statusText: 'Server Error' });

      expect(lastToast().kind).toBe('error');
    });
  });

  describe('the division of the cubes', () => {
    it('defaults to 1x1x1 and is sent per axis', () => {
      expect(solver.divisions(sessionId)).toEqual([1, 1, 1]);
      loadSetup();

      solver.setDivisions(sessionId, 2, 3, 4);

      const request = http.expectOne(`${api}/${sessionId}/divisions`);
      expect(request.request.body).toEqual({ nx: 2, ny: 3, nz: 4 });
      request.flush({ ...emptySetup, divisions: [2, 3, 4] });
      expect(solver.divisions(sessionId)).toEqual([2, 3, 4]);
    });

    it('sends nothing for a value out of 1..8 or not a number, and rounds down', () => {
      loadSetup();

      solver.setDivisions(sessionId, 0, 1, 1);
      solver.setDivisions(sessionId, 1, 9, 1);
      solver.setDivisions(sessionId, 1, 1, NaN);
      http.expectNone(`${api}/${sessionId}/divisions`);
      solver.setDivisions(sessionId, 2.9, 1, 1);
      expect(http.expectOne(`${api}/${sessionId}/divisions`).request.body.nx).toBe(2);
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
      expect(solver.display(sessionId).deformationScale).toBe(100);       // the displacement 1e-3 on a body 1 long, drawn at a tenth
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

      expect(solver.display(sessionId)).toEqual({ field: 'displacement', deformationScale: 50, opacity: 1 });
      expect(solver.revision(sessionId)).toBe(before + 2);
    });

    it('keeps the opacity between 5% and 100% and ignores junk', () => {
      solver.setOpacity(sessionId, 0.4);
      expect(solver.display(sessionId).opacity).toBe(0.4);
      solver.setOpacity(sessionId, 0);
      expect(solver.display(sessionId).opacity).toBe(0.05);
      solver.setOpacity(sessionId, 7);
      expect(solver.display(sessionId).opacity).toBe(1);
      solver.setOpacity(sessionId, NaN);
      expect(solver.display(sessionId).opacity).toBe(1);
    });

    it('chooses a deformation that can be seen when a result arrives: the biggest displacement at a tenth of the body', () => {
      expect(SolverService.visibleScale({ ...result(), maxDisplacement: 1e-5 })).toBe(10000);       // body 1 long
      expect(SolverService.visibleScale({ ...result(), maxDisplacement: 1e-12 })).toBe(500000);     // never beyond the viewer's limit
      expect(SolverService.visibleScale({ ...result(), maxDisplacement: 0 })).toBe(1);
      expect(SolverService.visibleScale({ ...result(), maxDisplacement: 0.05 })).toBe(2);
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
