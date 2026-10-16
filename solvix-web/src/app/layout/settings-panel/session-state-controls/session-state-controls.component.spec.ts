import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SessionStateControlsComponent } from './session-state-controls.component';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { SolverService } from '../../../state/solver.service';
import { SessionsService } from '../../../state/sessions.service';
import { MeshEditorSelectionService } from '../../../state/mesh-editor-selection.service';
import { MeshStateDto } from '../../../api/mesh-editor-api.service';
import { singleCubeState } from '../../../geometry/mesh-state.fixture.spec';

describe('SessionStateControlsComponent', () => {
  let state: MeshStateDto | null;
  let editor: jasmine.SpyObj<MeshEditorService>;
  let solver: jasmine.SpyObj<SolverService>;
  let selection: MeshEditorSelectionService;
  let component: SessionStateControlsComponent;

  beforeEach(() => {
    state = singleCubeState();
    editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['getState', 'reset']);
    editor.getState.and.callFake(() => state);
    Object.defineProperty(editor, 'busy', { get: () => signal(false) });
    solver = jasmine.createSpyObj<SolverService>('SolverService', ['forget']);
    TestBed.configureTestingModule({ providers: [{ provide: MeshEditorService, useValue: editor }, { provide: SolverService, useValue: solver }] });
    selection = TestBed.inject(MeshEditorSelectionService);
    component = TestBed.runInInjectionContext(() => new SessionStateControlsComponent());
    component.sessionId = 1;
  });

  it('counts the cubes and the nodes of the mesh', () => {
    expect(component.hexCount()).toBe(1);
    expect(component.nodeCount()).toBe(singleCubeState().nodes.length);
    state = null;
    expect(component.hexCount()).toBe(0);
  });

  it('asks twice before resetting the mesh', () => {
    component.requestReset();
    expect(editor.reset).not.toHaveBeenCalled();
    component.cancelReset();
    expect(component.isResetConfirming).toBeFalse();

    component.requestReset();
    component.confirmReset();
    expect(editor.reset).toHaveBeenCalledWith(1);
    expect(solver.forget).toHaveBeenCalledWith(1);     // the old cubes' supports and loads are gone on the server
  });

  it('does nothing without a session', () => {
    component.sessionId = null;
    component.confirmReset();
    component.confirmRestart();
    expect(editor.reset).not.toHaveBeenCalled();
    expect(solver.forget).not.toHaveBeenCalled();
  });

  describe('start over (whole session)', () => {
    it('asks first, and cancelling changes nothing', () => {
      const sessions = TestBed.inject(SessionsService);
      const before = sessions.sessions().map(s => s.id);
      component.sessionId = before[0];

      component.requestRestart();
      expect(component.isRestartConfirming).toBeTrue();
      component.cancelRestart();

      expect(component.isRestartConfirming).toBeFalse();
      expect(sessions.sessions().map(s => s.id)).toEqual(before);
    });

    it('confirming replaces the session with a fresh one and clears the selection', () => {
      const sessions = TestBed.inject(SessionsService);
      const old = sessions.sessions()[0].id;
      component.sessionId = old;
      selection.toggleHex(old, 3);
      selection.selectNode(old, 7);

      component.requestRestart();
      component.confirmRestart();

      expect(component.isRestartConfirming).toBeFalse();
      expect(sessions.sessions().map(s => s.id)).not.toContain(old);
      expect(sessions.sessions().length).toBe(1);
      expect(sessions.activeSessionId()).toBe(sessions.sessions()[0].id);
      expect(selection.hexes(old)).toEqual([]);
      expect(selection.nodeId(old)).toBeNull();
    });
  });

  describe('the question', () => {
    it('is short, so the buttons stay near, and the panel is scrolled to them', fakeAsync(() => {
      const fixture = TestBed.createComponent(SessionStateControlsComponent);
      fixture.componentInstance.sessionId = 1;
      fixture.detectChanges();
      const scrolled = spyOn(fixture.nativeElement as HTMLElement, 'scrollIntoView');

      fixture.componentInstance.requestRestart();
      fixture.detectChanges();
      tick();

      const question = fixture.nativeElement.querySelector('.selected') as HTMLElement;
      expect(question.textContent!.length).toBeLessThan(50);
      expect(scrolled).toHaveBeenCalledWith(jasmine.objectContaining({ block: 'end' }));

      fixture.componentInstance.cancelRestart();
      fixture.componentInstance.requestReset();
      fixture.detectChanges();
      tick();
      expect(scrolled).toHaveBeenCalledTimes(2);
    }));
  });
});
