import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { MeshEditorService } from './mesh-editor.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import { NotificationService } from './notification.service';
import { SessionsService } from './sessions.service';
import { MeshCommandResultDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { singleCubeState } from '../geometry/mesh-state.fixture.spec';

describe('MeshEditorService', () => {
  let editor: MeshEditorService;
  let http: HttpTestingController;
  let sessions: SessionsService;
  let notifications: NotificationService;
  let selection: MeshEditorSelectionService;
  let sessionId: number;

  const url = (path: string) => `${environment.apiBaseUrl}/api/mesh-editor/${sessionId}/${path}`;
  const emptyState: MeshStateDto = { version: 0, canUndo: false, canRedo: false, nodes: [], hexes: [], links: [], faces: [], invalidHexes: [] };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    sessions = TestBed.inject(SessionsService);
    notifications = TestBed.inject(NotificationService);
    selection = TestBed.inject(MeshEditorSelectionService);
    editor = TestBed.inject(MeshEditorService);
    sessionId = sessions.sessions()[0].id;
    TestBed.flushEffects();
  });

  afterEach(() => http.verify());

  function loadInitialState(state: MeshStateDto = emptyState): void {
    http.expectOne(url('state')).flush(state);
  }

  it('fetches the active session state once, when it becomes active', () => {
    expect(editor.getState(sessionId)).toBeNull();

    loadInitialState();

    expect(editor.getState(sessionId)).toEqual(emptyState);
    TestBed.flushEffects();
    http.expectNone(url('state'));
  });

  it('fetches a newly created session as soon as it is active', () => {
    loadInitialState();

    sessions.createSession();
    TestBed.flushEffects();

    const second = sessions.activeSessionId()!;
    http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/${second}/state`).flush(emptyState);
    expect(editor.getState(second)).toEqual(emptyState);
  });

  it('applies the state a command returns and clears busy', () => {
    loadInitialState();

    editor.addFirstHex(sessionId);
    expect(editor.busy()).toBeTrue();
    const result: MeshCommandResultDto = { ok: true, error: null, state: singleCubeState() };
    http.expectOne(url('hexes/first')).flush(result);

    expect(editor.getState(sessionId)).toEqual(singleCubeState());
    expect(editor.busy()).toBeFalse();
  });

  it('shows the reason of a refused command as a warning and still takes the returned state', () => {
    loadInitialState(singleCubeState());

    editor.addHexOnFace(sessionId, 0, 'XPlus');
    http.expectOne(url('hexes/0/faces/XPlus/attach')).flush({ ok: false, error: 'That face is already linked.', state: singleCubeState(5) });

    expect(notifications.toasts().map(t => [t.kind, t.message])).toEqual([['warning', 'That face is already linked.']]);
    expect(editor.getState(sessionId)!.version).toBe(5);
  });

  it('reports an unreachable server as an error toast and does not stay busy', () => {
    loadInitialState();

    editor.undo(sessionId);
    http.expectOne(url('undo')).flush('boom', { status: 500, statusText: 'Server Error' });

    expect(notifications.toasts()[0].kind).toBe('error');
    expect(editor.busy()).toBeFalse();
  });

  it('retries the state fetch for a session whose first fetch failed', () => {
    http.expectOne(url('state')).flush('down', { status: 503, statusText: 'Unavailable' });
    expect(notifications.toasts()[0].kind).toBe('error');

    sessions.createSession();
    TestBed.flushEffects();
    http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/${sessions.activeSessionId()}/state`).flush(emptyState);
    sessions.selectSession(sessionId);
    TestBed.flushEffects();

    http.expectOne(url('state')).flush(emptyState);
  });

  it('drops selected faces and nodes that the new state no longer has', () => {
    loadInitialState(singleCubeState());
    selection.toggleFace(sessionId, { hex: 0, face: 'XPlus' });
    selection.toggleFace(sessionId, { hex: 9, face: 'XPlus' });
    selection.selectNode(sessionId, 999);

    editor.refresh(sessionId);
    http.expectOne(url('state')).flush(singleCubeState(2));

    expect(selection.faces(sessionId)).toEqual([{ hex: 0, face: 'XPlus' }]);
    expect(selection.nodeId(sessionId)).toBeNull();
  });

  it('forwards link, unlink, move, redo and reset to the right endpoints', () => {
    loadInitialState();
    const ok: MeshCommandResultDto = { ok: true, error: null, state: emptyState };
    const expectAndFlush = (method: string, path: string, body?: unknown) => {
      const request = http.expectOne(url(path));
      expect(request.request.method).toBe(method);
      if (body !== undefined) expect(request.request.body).toEqual(body);
      request.flush(ok);
    };

    editor.linkFaces(sessionId, 1, 'XPlus', 2, 'XMinus', false);
    expectAndFlush('POST', 'links', { hexA: 1, faceA: 'XPlus', hexB: 2, faceB: 'XMinus', adaptSecond: false });
    editor.unlinkFace(sessionId, 1, 'XPlus');
    expectAndFlush('DELETE', 'hexes/1/faces/XPlus/link');
    editor.moveNode(sessionId, 4, { x: 1, y: 2, z: 3 }, true);
    expectAndFlush('PUT', 'nodes/4', { x: 1, y: 2, z: 3, carryEdgeMidpoints: true });
    editor.redo(sessionId);
    expectAndFlush('POST', 'redo');
    editor.reset(sessionId);
    expectAndFlush('POST', 'reset');
  });

  it('prunes the cached state of a closed session', () => {
    loadInitialState(singleCubeState());
    sessions.createSession();
    TestBed.flushEffects();
    http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/${sessions.activeSessionId()}/state`).flush(emptyState);

    sessions.closeSession(sessionId);
    TestBed.flushEffects();

    expect(editor.getState(sessionId)).toBeNull();
  });
});
