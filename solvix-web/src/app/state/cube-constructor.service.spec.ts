import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { CubeConstructorService, UNIT_PARAMETERS, unitPositions } from './cube-constructor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { MeshEditorService } from './mesh-editor.service';
import { NotificationService } from './notification.service';
import { SessionsService } from './sessions.service';
import { MeshShapeDto, MeshShapePresetDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { LOCAL_COORDS } from '../geometry/mesh-editor-view';
import { singleCubeState } from '../geometry/mesh-state.fixture.spec';

describe('CubeConstructorService', () => {
  let constructor_: CubeConstructorService;
  let http: HttpTestingController;
  let editor: MeshEditorService;
  let selection: MeshEditorSelectionService;
  let notifications: NotificationService;
  let sessionId: number;

  const api = `${environment.apiBaseUrl}/api/mesh-editor`;
  const emptyState: MeshStateDto = { version: 0, canUndo: false, canRedo: false, nodes: [], hexes: [], links: [], faces: [], invalidHexes: [] };
  const beam: MeshShapePresetDto = { name: 'beam', label: 'Брус 3×1×1', parameters: { length: 3, height: 1, depth: 1, taper: 1, shearX: 0, shearZ: 0 } };
  const beamShape = (): MeshShapeDto => ({ positions: LOCAL_COORDS.map(([a, b, g]) => ({ x: ((a + 1) / 2) * 3, y: (b + 1) / 2, z: (g + 1) / 2 })) });

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    constructor_ = TestBed.inject(CubeConstructorService);
    editor = TestBed.inject(MeshEditorService);
    selection = TestBed.inject(MeshEditorSelectionService);
    notifications = TestBed.inject(NotificationService);
    sessionId = TestBed.inject(SessionsService).sessions()[0].id;
    TestBed.flushEffects();
  });

  afterEach(() => {
    constructor_.close();
    http.match(() => true);
  });

  function loadState(state: MeshStateDto): void {
    http.expectOne(`${api}/${sessionId}/state`).flush(state);
  }

  it('starts as the regular unit cube with nothing picked and the window closed', () => {
    expect(constructor_.isOpen()).toBeFalse();
    expect(constructor_.positions).toEqual(unitPositions());
    expect(constructor_.positions.length).toBe(20);
    expect(constructor_.parameters).toEqual(UNIT_PARAMETERS);
    expect(constructor_.selectedSlot).toBeNull();
    expect(unitPositions()[6]).toEqual({ x: 1, y: 1, z: 1 });
    expect(unitPositions()[8]).toEqual({ x: 0.5, y: 0, z: 0 });
  });

  it('opening loads the library once and asks the server to check the draft', () => {
    constructor_.open();

    http.expectOne(`${api}/shapes/presets`).flush([beam]);
    http.expectOne(`${api}/shapes/check`).flush({ valid: true, minDeterminant: 0.125, error: null });
    expect(constructor_.isOpen()).toBeTrue();
    expect(constructor_.presets()).toEqual([beam]);
    expect(constructor_.check?.valid).toBeTrue();

    constructor_.close();
    constructor_.open();
    http.expectNone(`${api}/shapes/presets`);               // already loaded
    http.expectOne(`${api}/shapes/check`).flush({ valid: true, minDeterminant: 0.125, error: null });
  });

  it('reports an unreachable library as an error toast', () => {
    constructor_.loadPresets();

    http.expectOne(`${api}/shapes/presets`).flush('x', { status: 500, statusText: 'Server Error' });

    expect(notifications.toasts()[0].kind).toBe('error');
  });

  it('a preset fills the parameter fields and replaces the draft with the server-built shape', () => {
    constructor_.presets.set([beam]);
    constructor_.selectSlot(3);

    constructor_.applyPreset('beam');

    const request = http.expectOne(`${api}/shapes/parametric`);
    expect(request.request.body).toEqual(beam.parameters);
    request.flush(beamShape());
    expect(constructor_.parameters).toEqual(beam.parameters);
    expect(constructor_.positions[6]).toEqual({ x: 3, y: 1, z: 1 });
    expect(constructor_.selectedSlot).toBeNull();
  });

  it('an unknown preset changes nothing', () => {
    constructor_.applyPreset('nope');

    http.expectNone(`${api}/shapes/parametric`);
    expect(constructor_.positions).toEqual(unitPositions());
  });

  it('parameters are edited field by field and non-numbers are ignored; applying sends them all', () => {
    constructor_.setParameter('length', 2.5);
    constructor_.setParameter('taper', NaN);
    constructor_.setParameter('height', Infinity);
    constructor_.setParameter('shearX', 0.4);

    expect(constructor_.parameters).toEqual({ length: 2.5, height: 1, depth: 1, taper: 1, shearX: 0.4, shearZ: 0 });
    constructor_.applyParameters();
    expect(http.expectOne(`${api}/shapes/parametric`).request.body).toEqual(constructor_.parameters);
  });

  it('a failed build leaves the draft as it was and says so', () => {
    constructor_.applyParameters();

    http.expectOne(`${api}/shapes/parametric`).flush('x', { status: 503, statusText: 'Unavailable' });

    expect(constructor_.positions).toEqual(unitPositions());
    expect(notifications.toasts()[0].kind).toBe('error');
  });

  it('re-frames the views only when the whole shape is replaced, not while a node moves', () => {
    const frame = constructor_.frameRevision;

    constructor_.setNodePosition(6, { x: 1.2, y: 1, z: 1 });
    constructor_.selectSlot(2);
    expect(constructor_.frameRevision).toBe(frame);

    constructor_.resetToUnit();
    expect(constructor_.frameRevision).toBe(frame + 1);

    constructor_.applyParameters();
    http.expectOne(`${api}/shapes/parametric`).flush(beamShape());
    expect(constructor_.frameRevision).toBe(frame + 2);
  });

  it('moves one node, ignores non-numbers and out-of-range slots, and bumps the revision', () => {
    const before = constructor_.revision;

    constructor_.setNodePosition(6, { x: 1.5, y: 1.2, z: 0.9 });
    expect(constructor_.positions[6]).toEqual({ x: 1.5, y: 1.2, z: 0.9 });
    expect(constructor_.positions[5]).toEqual(unitPositions()[5]);
    expect(constructor_.revision).toBe(before + 1);

    constructor_.setNodePosition(6, { x: NaN, y: 0, z: 0 });
    constructor_.setNodePosition(20, { x: 1, y: 1, z: 1 });
    constructor_.setNodePosition(-1, { x: 1, y: 1, z: 1 });
    expect(constructor_.positions[6]).toEqual({ x: 1.5, y: 1.2, z: 0.9 });
    expect(constructor_.revision).toBe(before + 1);
  });

  it('checks the draft shortly after the last change, once, not after every keystroke', fakeAsync(() => {
    constructor_.setNodePosition(0, { x: -0.1, y: 0, z: 0 });
    tick(100);
    constructor_.setNodePosition(0, { x: -0.2, y: 0, z: 0 });
    tick(200);
    http.expectNone(`${api}/shapes/check`);

    tick(100);

    const check = http.expectOne(`${api}/shapes/check`);
    expect((check.request.body as MeshShapeDto).positions[0]).toEqual({ x: -0.2, y: 0, z: 0 });
    check.flush({ valid: false, minDeterminant: -0.1, error: null });
    expect(constructor_.check?.valid).toBeFalse();
  }));

  it('a failed check clears the verdict instead of keeping a stale one', () => {
    constructor_.check = { valid: true, minDeterminant: 1, error: null };

    constructor_.runCheck();
    http.expectOne(`${api}/shapes/check`).flush('x', { status: 500, statusText: 'Server Error' });

    expect(constructor_.check).toBeNull();
  });

  it('reset goes back to the unit cube and its parameters', () => {
    constructor_.setParameter('length', 5);
    constructor_.setNodePosition(2, { x: 9, y: 9, z: 9 });
    constructor_.selectSlot(2);

    constructor_.resetToUnit();

    expect(constructor_.positions).toEqual(unitPositions());
    expect(constructor_.parameters).toEqual(UNIT_PARAMETERS);
    expect(constructor_.selectedSlot).toBeNull();
  });

  it('picking the same node twice does not bump the revision', () => {
    constructor_.selectSlot(4);
    const revision = constructor_.revision;

    constructor_.selectSlot(4);

    expect(constructor_.revision).toBe(revision);
  });

  describe('where the cube goes', () => {
    it('into an empty body as its first cube', () => {
      loadState(emptyState);

      expect(constructor_.target().kind).toBe('first');
    });

    it('onto the face picked on the scene when it is free', () => {
      loadState(singleCubeState());
      selection.selectFace(sessionId, { hex: 0, face: 'XPlus' });

      const target = constructor_.target();

      expect(target.kind).toBe('face');
      expect(target).toEqual(jasmine.objectContaining({ hex: 0, face: 'XPlus' }));
    });

    it('nowhere without a picked face, or with a taken one - and it says what to do', () => {
      loadState(singleCubeState());
      expect(constructor_.target().kind).toBe('none');
      expect(constructor_.target().text).toContain('виберіть вільну грань');

      const base = singleCubeState();
      selection.selectFace(sessionId, { hex: 0, face: 'XPlus' });
      editor.refresh(sessionId);
      http.expectOne(`${api}/${sessionId}/state`).flush({
        ...base,
        faces: base.faces.map(f => (f.face === 'XPlus' ? { ...f, status: 'Linked' as const, otherHex: 1, otherFace: 'XMinus' as const } : f))
      });
      expect(constructor_.target().kind).toBe('none');
      expect(constructor_.target().text).toContain('зайнята');
    });

    it('nowhere before the state has loaded', () => {
      expect(constructor_.target().kind).toBe('none');
    });
  });

  describe('confirm', () => {
    it('sends the draft as the first cube and closes', () => {
      loadState(emptyState);
      constructor_.isOpen.set(true);
      constructor_.setNodePosition(6, { x: 2, y: 2, z: 2 });

      constructor_.confirm();

      const request = http.expectOne(`${api}/${sessionId}/hexes/first`);
      expect((request.request.body as { shape: MeshShapeDto }).shape.positions[6]).toEqual({ x: 2, y: 2, z: 2 });
      expect((request.request.body as { shape: MeshShapeDto }).shape.positions.length).toBe(20);
      expect(constructor_.isOpen()).toBeFalse();
      request.flush({ ok: true, error: null, state: singleCubeState() });
    });

    it('sends it fitted onto the picked face, with the shape in the body, and clears the pick', () => {
      loadState(singleCubeState());
      selection.selectFace(sessionId, { hex: 0, face: 'YPlus' });
      constructor_.isOpen.set(true);

      constructor_.confirm();

      const request = http.expectOne(`${api}/${sessionId}/hexes/0/faces/YPlus/attach`);
      expect((request.request.body as { shape: MeshShapeDto }).shape.positions.length).toBe(20);
      expect(selection.face(sessionId)).toBeNull();
      expect(constructor_.isOpen()).toBeFalse();
      request.flush({ ok: true, error: null, state: singleCubeState(2) });
    });

    it('without a target it only warns and stays open', () => {
      loadState(singleCubeState());
      constructor_.isOpen.set(true);

      constructor_.confirm();

      expect(notifications.toasts()[0].kind).toBe('warning');
      expect(notifications.toasts()[0].message).toContain('виберіть вільну грань');
      expect(constructor_.isOpen()).toBeTrue();
    });
  });
});
