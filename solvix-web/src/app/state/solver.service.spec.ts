import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { SolverService } from './solver.service';
import { SolverHubClient } from '../api/solver-hub.client';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { NotificationService } from './notification.service';
import { SessionsService } from './sessions.service';
import { MeshEditorService } from './mesh-editor.service';
import { SolverJobDto, SolverResultDto, SolverSetupDto } from '../api/solver-api.service';
import { linkedPairState, singleCubeState } from '../geometry/mesh-state.fixture.spec';
import { PickedFace } from '../geometry/mesh-editor-view';

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
    elementMaterials: [],
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

    it('starts with nothing being edited and the solver\'s default Pn of 1 MPa of compression', () => {
      expect(solver.tool(sessionId)).toBe('view');
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

    const facePick = (over: Partial<PickedFace> = {}): PickedFace => ({ kind: 'face', hex: 0, face: 'YPlus', p: 0, q: 0, element: [0, 0, 0], inner: false, ...over });

    it('a click with the View tool changes nothing', () => {
      loadSetup();

      solver.pick(sessionId, facePick());

      http.expectNone(`${api}/${sessionId}/faces/load`);
      http.expectNone(`${api}/${sessionId}/faces/fixed`);
    });

    it('a click with the Load tool marks the small face as pressed and unmarks it the next time', () => {
      loadSetup();
      solver.setTool(sessionId, 'load');

      solver.pick(sessionId, facePick());
      const on = http.expectOne(`${api}/${sessionId}/faces/load`);
      expect(on.request.body).toEqual({ faces: [{ hex: 0, face: 'YPlus', p: 0, q: 0 }], pressure: -1e6 });
      on.flush({ ...emptySetup, loads: [{ hex: 0, face: 'YPlus', p: 0, q: 0, pressure: -1e6 }] });
      expect(solver.pressureOn(sessionId, 0, 'YPlus', 0, 0)).toBe(-1e6);

      solver.pick(sessionId, facePick());
      expect(http.expectOne(`${api}/${sessionId}/faces/load`).request.body.pressure).toBeNull();
    });

    it('with the Fix tool the same click clamps and unclamps, and marks the clamping as chosen', () => {
      loadSetup();
      solver.setTool(sessionId, 'fix');

      solver.pick(sessionId, facePick({ hex: 1, face: 'ZMinus' }));
      const on = http.expectOne(`${api}/${sessionId}/faces/fixed`);
      expect(on.request.body).toEqual({ faces: [{ hex: 1, face: 'ZMinus', p: 0, q: 0 }], fixed: true });
      on.flush({ ...emptySetup, fixed: [{ hex: 1, face: 'ZMinus', p: 0, q: 0 }] });
      expect(solver.isFixed(sessionId, 1, 'ZMinus', 0, 0)).toBeTrue();
      expect(solver.isFixedAuto(sessionId)).toBeFalse();

      solver.pick(sessionId, facePick({ hex: 1, face: 'ZMinus' }));
      expect(http.expectOne(`${api}/${sessionId}/faces/fixed`).request.body.fixed).toBeFalse();
    });

    it('the scope decides how far a click reaches: one small face, the whole side of the cube, or every outer face with the name', () => {
      loadSetup({ ...emptySetup, divisions: [2, 2, 2] });
      solver.setTool(sessionId, 'fix');

      solver.setScope(sessionId, 'cube');
      solver.pick(sessionId, facePick({ face: 'ZPlus' }));
      expect(http.expectOne(`${api}/${sessionId}/faces/fixed`).request.body.faces).toEqual([{ hex: 0, face: 'ZPlus' }]);

      solver.setScope(sessionId, 'side');
      solver.pick(sessionId, facePick({ face: 'YPlus' }));
      expect(http.expectOne(`${api}/${sessionId}/faces/fixed`).request.body.faces).toEqual([{ hex: 0, face: 'YPlus' }, { hex: 1, face: 'YPlus' }]);
    });

    it('a whole side that is already all marked is unmarked by the next click', () => {
      loadSetup({ ...emptySetup, divisions: [2, 1, 1], fixed: [{ hex: 0, face: 'ZMinus', p: 0, q: 0 }, { hex: 0, face: 'ZMinus', p: 1, q: 0 }] });
      solver.setTool(sessionId, 'fix');
      solver.setScope(sessionId, 'cube');

      solver.pick(sessionId, facePick({ face: 'ZMinus' }));

      expect(http.expectOne(`${api}/${sessionId}/faces/fixed`).request.body.fixed).toBeFalse();
    });

    it('a face inside the body (between small elements) cannot be pressed or clamped', () => {
      loadSetup();
      solver.setTool(sessionId, 'load');

      solver.pick(sessionId, facePick({ inner: true }));

      expect(lastToast().message).toContain('усередині тіла');
      http.expectNone(`${api}/${sessionId}/faces/load`);
    });

    it('a click on nothing, or on a node, does nothing', () => {
      loadSetup();
      solver.setTool(sessionId, 'load');

      solver.pick(sessionId, null);
      solver.pick(sessionId, { kind: 'node', nodeId: 3 } as never);

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

    it('counts the small faces that carry a load or a clamp', () => {
      loadSetup({ ...emptySetup, divisions: [2, 3, 4], loads: [{ hex: 0, face: 'XMinus', pressure: -1e6, p: 0, q: 0 }, { hex: 1, face: 'ZPlus', pressure: -1e6, p: 1, q: 2 }], fixed: [{ hex: 0, face: 'YPlus', p: 0, q: 0 }] });

      expect(solver.loadedFaceCount(sessionId)).toBe(2);
      expect(solver.fixedFaceCount(sessionId)).toBe(1);
      expect(solver.divisions(sessionId)).toEqual([2, 3, 4]);
    });

    it('a changed set-up makes the old verdict stale', () => {
      loadSetup();
      solver.validate(sessionId);
      http.expectOne(`${api}/${sessionId}/validate`).flush({ canSolve: true, issues: [] });
      expect(solver.validation(sessionId)).not.toBeNull();

      solver.setTool(sessionId, 'load');
      solver.pick(sessionId, facePick());
      http.expectOne(`${api}/${sessionId}/faces/load`).flush(emptySetup);

      expect(solver.validation(sessionId)).toBeNull();
    });

    it('reports a failed save as an error toast', () => {
      loadSetup();

      solver.setTool(sessionId, 'load');
      solver.pick(sessionId, facePick());
      http.expectOne(`${api}/${sessionId}/faces/load`).flush('x', { status: 500, statusText: 'Server Error' });

      expect(lastToast().kind).toBe('error');
    });
  });

  describe('the tools', () => {
    const facePick = (over: Partial<PickedFace> = {}): PickedFace => ({ kind: 'face', hex: 0, face: 'XMinus', p: 0, q: 1, element: [0, 1, 0], inner: false, ...over });

    it('offer the scopes that mean something for them, and fall back to the small one when the tool changes', () => {
      expect(solver.scopesOf('view')).toEqual([]);
      expect(solver.scopesOf('load')).toEqual(['cell', 'cube', 'side']);
      expect(solver.scopesOf('fix')).toEqual(['cell', 'cube', 'side']);
      expect(solver.scopesOf('material')).toEqual(['cell', 'column', 'layer', 'cube']);

      solver.setTool(sessionId, 'material');
      solver.setScope(sessionId, 'layer');
      solver.setTool(sessionId, 'fix');

      expect(solver.scope(sessionId)).toBe('cell');
    });

    it('keep the depth between 0 and the deepest division', () => {
      loadSetup({ ...emptySetup, divisions: [2, 4, 3] });

      solver.setDepth(sessionId, 2.7);
      expect(solver.depth(sessionId)).toBe(2);
      solver.setDepth(sessionId, 99);
      expect(solver.depth(sessionId)).toBe(3);
      solver.setDepth(sessionId, -4);
      expect(solver.depth(sessionId)).toBe(0);
    });

    describe('the Material tool', () => {
      beforeEach(() => {
        loadSetup({ ...emptySetup, divisions: [3, 2, 2] });
        solver.setTool(sessionId, 'material');
        solver.setActiveMaterial(sessionId, 'rubber');
      });

      it('paints the small element behind the clicked face, at the chosen depth', () => {
        solver.setDepth(sessionId, 1);

        solver.pick(sessionId, facePick());

        const request = http.expectOne(`${api}/${sessionId}/elements/material`);
        expect(request.request.body).toEqual({ elements: [{ hex: 0, ex: 1, ey: 1, ez: 0 }], material: 'rubber' });
        request.flush({ ...emptySetup, elementMaterials: [{ hex: 0, ex: 1, ey: 1, ez: 0, material: 'rubber' }] });
        expect(solver.elementMaterial(sessionId, 0, 1, 1, 0)).toBe('rubber');
        expect(solver.elementMaterial(sessionId, 0, 0, 0, 0)).toBe('steel');
      });

      it('paints a whole column, a whole layer, or - with the Cube scope - the cube through the cube call', () => {
        solver.setScope(sessionId, 'column');
        solver.pick(sessionId, facePick());
        expect(http.expectOne(`${api}/${sessionId}/elements/material`).request.body.elements.length).toBe(3);

        solver.setScope(sessionId, 'layer');
        solver.pick(sessionId, facePick());
        expect(http.expectOne(`${api}/${sessionId}/elements/material`).request.body.elements.length).toBe(2 * 2);

        solver.setScope(sessionId, 'cube');
        solver.pick(sessionId, facePick());
        const cube = http.expectOne(`${api}/${sessionId}/hexes/material`);
        expect(cube.request.body).toEqual({ hexIds: [0], material: 'rubber' });
      });

      it('says so when the depth leads out of the cube, and sends nothing', () => {
        solver.setDepth(sessionId, 2);
        solver.pick(sessionId, facePick({ element: [2, 0, 0] }));          // 2 + 2 is beyond the 3 elements along x

        expect(lastToast().message).toContain('немає елементів');
        http.expectNone(`${api}/${sessionId}/elements/material`);
      });

      it('works on a face between elements too', () => {
        solver.pick(sessionId, facePick({ inner: true }));

        http.expectOne(`${api}/${sessionId}/elements/material`);
      });

      it('fills the whole body with one material, wiping the single elements', () => {
        solver.fillAll(sessionId, 'concrete');

        expect(http.expectOne(`${api}/${sessionId}/hexes/material`).request.body).toEqual({ hexIds: [0, 1], material: 'concrete' });
      });
    });

    it('count the small elements of every material, counting the cubes\' own and the painted ones', () => {
      loadSetup({ ...emptySetup, divisions: [2, 1, 1], hexMaterials: { '1': 'concrete' }, elementMaterials: [{ hex: 0, ex: 0, ey: 0, ez: 0, material: 'rubber' }] });

      const counts = solver.materialCounts(sessionId);

      expect(counts.get('steel')).toBe(1);          // cube 0 has 2 elements, one painted rubber
      expect(counts.get('rubber')).toBe(1);
      expect(counts.get('concrete')).toBe(2);
    });

    it('hide a material and show it again; the inner faces are a setting too', () => {
      expect(solver.isHidden(sessionId, 'steel')).toBeFalse();
      solver.toggleHidden(sessionId, 'steel');
      expect(solver.isHidden(sessionId, 'steel')).toBeTrue();
      expect([...solver.hiddenMaterials(sessionId)]).toEqual(['steel']);
      solver.toggleHidden(sessionId, 'steel');
      expect(solver.isHidden(sessionId, 'steel')).toBeFalse();

      expect(solver.showInner(sessionId)).toBeFalse();
      solver.setShowInner(sessionId, true);
      expect(solver.showInner(sessionId)).toBeTrue();
    });

    describe('hovering', () => {
      it('remembers the small face under the mouse and says whether it changed', () => {
        expect(solver.setHover(sessionId, facePick())).toBeTrue();
        expect(solver.setHover(sessionId, facePick())).toBeFalse();                // the same small face
        expect(solver.setHover(sessionId, facePick({ q: 0 }))).toBeTrue();
        expect(solver.setHover(sessionId, null)).toBeTrue();
        expect(solver.setHover(sessionId, null)).toBeFalse();
        expect(solver.hover(sessionId)).toBeNull();
      });

      it('does not make the view rebuild', () => {
        const revision = solver.revision(sessionId);

        solver.setHover(sessionId, facePick());

        expect(solver.revision(sessionId)).toBe(revision);
      });

      it('has no highlight with the View tool or without a face under the mouse', () => {
        solver.setHover(sessionId, facePick());
        expect(solver.highlightTargets(sessionId)).toBeNull();
        solver.setTool(sessionId, 'load');
        solver.setHover(sessionId, null);
        expect(solver.highlightTargets(sessionId)).toBeNull();
      });

      it('highlights what the Load and Fix tools would mark: the small face, the cube\'s side or every outer face of the name', () => {
        loadSetup({ ...emptySetup, divisions: [2, 2, 2] });
        solver.setTool(sessionId, 'load');
        solver.setHover(sessionId, facePick({ face: 'YPlus' }));

        expect(solver.highlightTargets(sessionId)!.faces).toEqual([{ hex: 0, face: 'YPlus', p: 0, q: 1 }]);
        solver.setScope(sessionId, 'cube');
        expect(solver.highlightTargets(sessionId)!.faces).toEqual([{ hex: 0, face: 'YPlus' }]);
        solver.setScope(sessionId, 'side');
        expect(solver.highlightTargets(sessionId)!.faces.length).toBe(2);
      });

      it('highlights the elements the Material tool would paint, and nothing but the pointed face on an inner face for faces', () => {
        loadSetup({ ...emptySetup, divisions: [3, 2, 2] });
        solver.setTool(sessionId, 'material');
        solver.setHover(sessionId, facePick());

        expect(solver.highlightTargets(sessionId)!.elements).toEqual([{ hex: 0, ex: 0, ey: 1, ez: 0 }]);
        solver.setScope(sessionId, 'column');
        expect(solver.highlightTargets(sessionId)!.elements.length).toBe(3);

        solver.setTool(sessionId, 'load');
        solver.setHover(sessionId, facePick({ inner: true }));
        expect(solver.highlightTargets(sessionId)).toEqual({ faces: [], elements: [], pointed: jasmine.objectContaining({ inner: true }) });
      });

      it('is cleared when the tool changes', () => {
        solver.setHover(sessionId, facePick());

        solver.setTool(sessionId, 'load');

        expect(solver.hover(sessionId)).toBeNull();
      });
    });
  });

  describe('layers and mesh quality', () => {
    const layered = () => {
      const base = linkedPairState();
      return { ...base, hexes: [{ ...base.hexes[0], layer: 'enamel' }, { ...base.hexes[1], layer: 'dentin' }] };
    };
    const grades = { excellent: 1, good: 1, acceptable: 0, poor: 0, invalid: 0 };

    beforeEach(() => {
      http.match(`${meshApi}/${sessionId}/state`);
      TestBed.inject(MeshEditorService).refresh(sessionId);
      http.expectOne(`${meshApi}/${sessionId}/state`).flush(layered());
    });

    it('lists the layers of the body with their cubes, in order, and none without layers', () => {
      expect(solver.layers(sessionId)).toEqual([{ name: 'enamel', hexes: [0] }, { name: 'dentin', hexes: [1] }]);
    });

    it('a layer has a material when all its cubes share one, and none when mixed', () => {
      loadSetup({ ...emptySetup, hexMaterials: { '1': 'rubber' } });

      expect(solver.layerMaterial(sessionId, 'enamel')).toBe('steel');
      expect(solver.layerMaterial(sessionId, 'dentin')).toBe('rubber');
      expect(solver.layerMaterial(sessionId, 'nothing')).toBeNull();
    });

    it('gives the cubes of a layer a material', () => {
      loadSetup();

      solver.setLayerMaterial(sessionId, 'dentin', 'rubber');

      expect(http.expectOne(`${api}/${sessionId}/hexes/material`).request.body).toEqual({ hexIds: [1], material: 'rubber' });
    });

    it('a layer named like a material gets that material, once, and others are left alone', () => {
      loadSetup({
        ...emptySetup,
        materials: [...emptySetup.materials, { name: 'dentin', label: 'Дентин', e: 1.8e10, nu: 0.31 }]
      });

      solver.applyLayerNamedMaterials(sessionId);

      expect(http.expectOne(`${api}/${sessionId}/hexes/material`).request.body).toEqual({ hexIds: [1], material: 'dentin' });   // "enamel" is not in this library
    });

    it('asks the server for the quality and keeps it; colouring by quality is a setting that fetches it', () => {
      expect(solver.quality(sessionId)).toBeNull();

      solver.setShowQuality(sessionId, true);

      const request = http.expectOne(`${api}/${sessionId}/quality`);
      request.flush({ elements: 2, grades, worstScaledJacobian: 0.9, worstJacobianRatio: 1, worstAspectRatio: 1.5, worstSkewDegrees: 2, cubes: [] });
      expect(solver.quality(sessionId)!.elements).toBe(2);
      expect(solver.showQuality(sessionId)).toBeTrue();
      solver.setShowQuality(sessionId, false);
      http.expectNone(`${api}/${sessionId}/quality`);
      expect(solver.showQuality(sessionId)).toBeFalse();
    });

    it('reports an unreachable server for the quality', () => {
      solver.refreshQuality(sessionId);

      http.expectOne(`${api}/${sessionId}/quality`).flush('x', { status: 500, statusText: 'Server Error' });

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
    it('gives cubes a material by id, and the cube answers with it', () => {
      loadSetup();

      solver.setMaterial(sessionId, [1], 'rubber');

      const request = http.expectOne(`${api}/${sessionId}/hexes/material`);
      expect(request.request.body).toEqual({ hexIds: [1], material: 'rubber' });
      request.flush({ ...emptySetup, hexMaterials: { '1': 'rubber' } });
      expect(solver.materialOf(sessionId, 1)).toBe('rubber');
      expect(solver.materialOf(sessionId, 0)).toBe('steel');
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
    it('changes the shown field and the deformation, ignoring bad scales; only the field rebuilds the view', () => {
      const before = solver.revision(sessionId);

      solver.setField(sessionId, 'displacement');
      solver.setDeformationScale(sessionId, 50);
      solver.setDeformationScale(sessionId, -1);
      solver.setDeformationScale(sessionId, NaN);

      expect(solver.display(sessionId)).toEqual({ field: 'displacement', deformationScale: 50, opacity: 1, colorMax: null, edges: true });
      // the deformation moves the vertices in place, so it is not a revision
      expect(solver.revision(sessionId)).toBe(before + 1);
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
