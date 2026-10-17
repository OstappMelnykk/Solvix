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
import { SolverService } from './solver.service';
import { SolverHubClient } from '../api/solver-hub.client';
import { SurfaceAttachmentService } from './surface-attachment.service';
import * as THREE from 'three';

describe('MeshEditorRenderService', () => {
  let render: MeshEditorRenderService;
  let editor: MeshEditorService;
  let selection: MeshEditorSelectionService;
  let http: HttpTestingController;
  let sessionId: number;

  const emptyState: MeshStateDto = { version: 0, canUndo: false, canRedo: false, nodes: [], hexes: [], links: [], faces: [], invalidHexes: [] };

  beforeEach(() => {
    const hub = jasmine.createSpyObj<SolverHubClient>('SolverHubClient', ['onJobChanged', 'join', 'leave']);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), { provide: SolverHubClient, useValue: hub }] });
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

  it('keeps the dragged face where it was dropped until the server answers, so the gizmo does not jump back', () => {
    loadState(singleCubeState(1));
    expect(render.facePreviewDelta(sessionId)).toBeNull();

    render.setFaceDragPreview(sessionId, 0, 'XPlus', { x: 0.3, y: 0, z: 0 });
    expect(render.facePreviewDelta(sessionId)).toEqual({ x: 0.3, y: 0, z: 0 });

    editor.moveFace(sessionId, 0, 'XPlus', { x: 0.3, y: 0, z: 0 });
    http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/${sessionId}/hexes/0/faces/XPlus/move`).flush({ ok: true, error: null, state: singleCubeState(2) });
    expect(render.facePreviewDelta(sessionId)).toBeNull();
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

    selection.toggleHex(sessionId, 0);
    const afterSelection = render.getView(sessionId, REAL_WORLD_INDEX);
    expect(afterSelection).not.toBe(first);
    expect(render.getView(sessionId, REAL_WORLD_INDEX)).toBe(afterSelection);

    editor.refresh(sessionId);
    http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/${sessionId}/state`).flush(singleCubeState(2));
    expect(render.getView(sessionId, REAL_WORLD_INDEX)).not.toBe(afterSelection);
  });

  it('draws the nodes stuck to the imported surface in a colour of their own in the Real World, and rebuilds when that changes', () => {
    loadState(singleCubeState());
    const attachments = TestBed.inject(SurfaceAttachmentService);
    const colourOf = (view: NonNullable<ReturnType<MeshEditorRenderService['getView']>>, id: number) => (view.nodeMeshes.get(id)!.material as THREE.MeshBasicMaterial).color.getHex();
    const plain = render.getView(sessionId, REAL_WORLD_INDEX)!;
    const plainColour = colourOf(plain, 4);

    attachments.attach(sessionId, 4);

    const stuck = render.getView(sessionId, REAL_WORLD_INDEX)!;
    expect(stuck).not.toBe(plain);
    expect(colourOf(stuck, 4)).not.toBe(plainColour);
    expect(colourOf(stuck, 5)).toBe(colourOf(plain, 5));
    expect(render.getView(sessionId, REAL_WORLD_INDEX)).toBe(stuck);
    // the Ideal World's lattice has nothing to stick to
    const ideal = render.getView(sessionId, IDEAL_WORLD_INDEX)!;
    expect(colourOf(ideal, 4)).toBe(plainColour);
  });

  it('forgets the stuck nodes that are no longer in the mesh', () => {
    loadState(singleCubeState());
    const attachments = TestBed.inject(SurfaceAttachmentService);
    attachments.attach(sessionId, 4);
    attachments.attach(sessionId, 9999);

    render.getView(sessionId, REAL_WORLD_INDEX);

    expect([...attachments.attached(sessionId)]).toEqual([4]);
  });

  it('rebuilds the view when the inner-grid setting changes', () => {
    loadState(singleCubeState());
    const first = render.getView(sessionId, REAL_WORLD_INDEX);

    TestBed.inject(SolverService).setDivisions(sessionId, 3, 3, 3);
    http.expectOne(`${environment.apiBaseUrl}/api/solver/${sessionId}/divisions`).flush({
      version: 1, divisions: [3, 3, 3], materials: [], defaultMaterial: 'steel', hexMaterials: {}, fixed: [], loads: []
    });
    const withGrid = render.getView(sessionId, REAL_WORLD_INDEX);
    http.match(`${environment.apiBaseUrl}/api/solver/${sessionId}/setup`);

    expect(withGrid).not.toBe(first);
    expect(render.getView(sessionId, REAL_WORLD_INDEX)).toBe(withGrid);
    expect(withGrid!.root.children.filter(c => c instanceof THREE.LineSegments && (c.material as THREE.Material).depthTest !== false).length).toBe(2);        // the edges and the inner grid (not the weaker copies)
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
