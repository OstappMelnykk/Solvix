import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { IDEAL_WORLD_INDEX, SOLVER_WORLD_INDEX } from '../config/app-settings';
import { SolverRenderService } from './solver-render.service';
import { SolverService } from './solver.service';
import { SolverHubClient } from '../api/solver-hub.client';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { SessionsService } from './sessions.service';
import { linkedPairState } from '../geometry/mesh-state.fixture.spec';

describe('SolverRenderService', () => {
  let render: SolverRenderService;
  let solver: SolverService;
  let selection: MeshEditorSelectionService;
  let http: HttpTestingController;
  let sessionId: number;

  beforeEach(() => {
    localStorage.clear();
    const hub = jasmine.createSpyObj<SolverHubClient>('SolverHubClient', ['onJobChanged', 'join', 'leave']);
    hub.join.and.resolveTo(true);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), { provide: SolverHubClient, useValue: hub }] });
    http = TestBed.inject(HttpTestingController);
    render = TestBed.inject(SolverRenderService);
    solver = TestBed.inject(SolverService);
    selection = TestBed.inject(MeshEditorSelectionService);
    sessionId = TestBed.inject(SessionsService).sessions()[0].id;
    TestBed.flushEffects();
  });

  afterEach(() => http.match(() => true));

  function loadMesh(): void {
    http.match(`${environment.apiBaseUrl}/api/mesh-editor/${sessionId}/state`).forEach(r => r.flush(linkedPairState()));
  }

  it('draws nothing outside the Solver World, without a session, and before the mesh has a cube', () => {
    expect(render.getView(sessionId, IDEAL_WORLD_INDEX)).toBeNull();
    expect(render.getView(null, SOLVER_WORLD_INDEX)).toBeNull();
    expect(render.getView(sessionId, SOLVER_WORLD_INDEX)).toBeNull();
  });

  it('draws the body in the Solver World, and keeps the same view until something changes', () => {
    loadMesh();

    const view = render.getView(sessionId, SOLVER_WORLD_INDEX);

    expect(view).not.toBeNull();
    expect(view!.pickables.length).toBe(10);
    expect(render.getView(sessionId, SOLVER_WORLD_INDEX)).toBe(view);
  });

  it('rebuilds when the selection or the display settings change', () => {
    loadMesh();
    const first = render.getView(sessionId, SOLVER_WORLD_INDEX);

    selection.selectFace(sessionId, { hex: 0, face: 'XMinus' });
    const afterPick = render.getView(sessionId, SOLVER_WORLD_INDEX);
    solver.setField(sessionId, 'displacement');
    const afterField = render.getView(sessionId, SOLVER_WORLD_INDEX);

    expect(afterPick).not.toBe(first);
    expect(afterField).not.toBe(afterPick);
  });

  it('shows a clamped face once the set-up arrives from the server', () => {
    loadMesh();
    render.getView(sessionId, SOLVER_WORLD_INDEX);
    http.expectOne(`${environment.apiBaseUrl}/api/solver/${sessionId}/setup`).flush({
      version: 1, materials: [], defaultMaterial: 'steel', hexMaterials: {}, fixed: [{ hex: 0, face: 'XMinus' }], loads: []
    });

    const view = render.getView(sessionId, SOLVER_WORLD_INDEX)!;

    const overlays = view.root.children.filter(c => c instanceof Object && (c as { material?: { transparent?: boolean } }).material?.transparent);
    expect(overlays.length).toBe(1);
  });
});
