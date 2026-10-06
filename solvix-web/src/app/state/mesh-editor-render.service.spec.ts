import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { IDEAL_WORLD_INDEX, REAL_WORLD_INDEX } from '../config/app-settings';
import { MeshEditorRenderService } from './mesh-editor-render.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { MeshEditorService } from './mesh-editor.service';
import { SessionsService } from './sessions.service';
import { MeshPick } from '../geometry/mesh-editor-view';
import { singleCubeState } from '../geometry/mesh-state.fixture.spec';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import * as THREE from 'three';

describe('MeshEditorRenderService', () => {
  let render: MeshEditorRenderService;
  let editor: MeshEditorService;
  let selection: MeshEditorSelectionService;
  let http: HttpTestingController;
  let sessionId: number;

  const emptyState: MeshStateDto = { version: 0, canUndo: false, canRedo: false, nodes: [], hexes: [], links: [], faces: [], invalidHexes: [] };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    render = TestBed.inject(MeshEditorRenderService);
    editor = TestBed.inject(MeshEditorService);
    selection = TestBed.inject(MeshEditorSelectionService);
    sessionId = TestBed.inject(SessionsService).sessions()[0].id;
    TestBed.flushEffects();
  });

  function loadState(state: MeshStateDto): void {
    http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/${sessionId}/state`).flush(state);
  }

  it('has nothing to draw without a session, without state, or for an empty mesh', () => {
    expect(render.getView(null, IDEAL_WORLD_INDEX)).toBeNull();
    expect(render.getView(sessionId, IDEAL_WORLD_INDEX)).toBeNull();

    loadState(emptyState);

    expect(render.getView(sessionId, IDEAL_WORLD_INDEX)).toBeNull();
  });

  it('has nothing to draw in the Solver World', () => {
    loadState(singleCubeState());

    expect(render.getView(sessionId, 2)).toBeNull();
  });

  it('returns the same view object until the state or the selection changes', () => {
    loadState(singleCubeState());

    const first = render.getView(sessionId, REAL_WORLD_INDEX);
    expect(first).not.toBeNull();
    expect(render.getView(sessionId, REAL_WORLD_INDEX)).toBe(first);

    selection.toggleFace(sessionId, { hex: 0, face: 'XPlus' });
    const afterSelection = render.getView(sessionId, REAL_WORLD_INDEX);
    expect(afterSelection).not.toBe(first);
    expect(render.getView(sessionId, REAL_WORLD_INDEX)).toBe(afterSelection);

    editor.refresh(sessionId);
    http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/${sessionId}/state`).flush(singleCubeState(2));
    expect(render.getView(sessionId, REAL_WORLD_INDEX)).not.toBe(afterSelection);
  });

  it('builds a separate view per World: lattice positions for Ideal, real positions for Real', () => {
    const moved = singleCubeState();
    loadState({ ...moved, nodes: moved.nodes.map(n => (n.id === 6 ? { ...n, x: 1.7 } : n)) });

    const nodeX = (worldIndex: number) => {
      const view = render.getView(sessionId, worldIndex)!;
      const node = view.pickables.find(o => {
        const p = o.userData['pick'] as MeshPick;
        return p.kind === 'node' && p.nodeId === 6;
      }) as THREE.Mesh;
      return node.position.x;
    };

    expect(render.getView(sessionId, IDEAL_WORLD_INDEX)).not.toBe(render.getView(sessionId, REAL_WORLD_INDEX));
    expect(nodeX(IDEAL_WORLD_INDEX)).toBe(1);
    expect(nodeX(REAL_WORLD_INDEX)).toBeCloseTo(1.7, 6);
  });

  it('drops the cached view when the mesh becomes empty again', () => {
    loadState(singleCubeState());
    expect(render.getView(sessionId, REAL_WORLD_INDEX)).not.toBeNull();

    editor.reset(sessionId);
    http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/${sessionId}/reset`).flush({ ok: true, error: null, state: emptyState });

    expect(render.getView(sessionId, REAL_WORLD_INDEX)).toBeNull();
  });
});
