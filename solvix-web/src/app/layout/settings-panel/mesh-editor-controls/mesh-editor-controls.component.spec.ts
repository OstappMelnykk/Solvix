import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { MeshEditorControlsComponent, SHORTCUTS } from './mesh-editor-controls.component';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { CubeConstructorService } from '../../../state/cube-constructor.service';
import { SolverService } from '../../../state/solver.service';
import { SessionsService } from '../../../state/sessions.service';
import { MeshEditorSelectionService } from '../../../state/mesh-editor-selection.service';
import { IDEAL_WORLD_INDEX, REAL_WORLD_INDEX } from '../../../config/app-settings';
import { MeshFaceDto, MeshStateDto } from '../../../api/mesh-editor-api.service';
import { linkedPairState, singleCubeState } from '../../../geometry/mesh-state.fixture.spec';

describe('MeshEditorControlsComponent', () => {
  let state: MeshStateDto | null;
  let editor: jasmine.SpyObj<MeshEditorService>;
  let selection: MeshEditorSelectionService;
  let busy: ReturnType<typeof signal<boolean>>;
  let component: MeshEditorControlsComponent;
  let constructorWindow: jasmine.SpyObj<CubeConstructorService>;
  let solver: jasmine.SpyObj<SolverService>;

  const emptyState: MeshStateDto = { version: 0, canUndo: false, canRedo: false, nodes: [], hexes: [], links: [], faces: [], invalidHexes: [] };

  beforeEach(() => {
    state = emptyState;
    busy = signal(false);
    editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', [
      'getState', 'addFirstHex', 'addHexOnFace', 'linkFaces', 'linkHexes', 'removeHex', 'unlinkFace', 'moveNode', 'undo', 'redo', 'reset', 'mapIdealToReal', 'mapRealToIdeal'
    ]);
    editor.getState.and.callFake(() => state);
    editor.carryEdgeMidpoints = false;
    Object.defineProperty(editor, 'busy', { get: () => busy });
    constructorWindow = jasmine.createSpyObj<CubeConstructorService>('CubeConstructorService', ['open']);
    solver = jasmine.createSpyObj<SolverService>('SolverService', ['forget', 'divisions', 'setDivisions']);
    solver.divisions.and.returnValue([1, 2, 3]);
    TestBed.configureTestingModule({
      providers: [
        { provide: MeshEditorService, useValue: editor },
        { provide: CubeConstructorService, useValue: constructorWindow },
        { provide: SolverService, useValue: solver }
      ]
    });
    selection = TestBed.inject(MeshEditorSelectionService);
    component = TestBed.runInInjectionContext(() => new MeshEditorControlsComponent());
    component.sessionId = 1;
    component.worldIndex = REAL_WORLD_INDEX;
  });

  it('offers "first cube" only for an empty mesh that has been loaded', () => {
    expect(component.canAddFirst()).toBeTrue();
    state = null;
    expect(component.canAddFirst()).toBeFalse();
    state = singleCubeState();
    expect(component.canAddFirst()).toBeFalse();
    state = emptyState;
    busy.set(true);
    expect(component.canAddFirst()).toBeFalse();
  });

  it('offers an add-a-cube button per free side of the single picked cube', () => {
    state = linkedPairState();
    selection.toggleHex(1, 0);

    expect(component.canAttach('XMinus')).toBeTrue();
    expect(component.canAttach('XPlus')).toBeFalse();   // linked to cube 1
    selection.toggleHex(1, 1);
    expect(component.canAttach('XMinus')).toBeFalse();  // two cubes picked: no attach
  });

  it('does not offer attaching to a side whose cell is taken by a not-yet-neighbour', () => {
    const base = singleCubeState();
    state = {
      ...base,
      faces: base.faces.map((f): MeshFaceDto => (f.face === 'XPlus' ? { ...f, status: 'Candidate', otherHex: 5, otherFace: 'XMinus', coincident: true, gap: 0 } : f))
    };
    selection.toggleHex(1, 0);

    expect(component.canAttach('XPlus')).toBeFalse();
    expect(component.canAttach('YPlus')).toBeTrue();
  });

  it('attaches on the chosen side of the picked cube', () => {
    state = singleCubeState();
    selection.toggleHex(1, 0);

    component.attach('ZPlus');

    expect(editor.addHexOnFace).toHaveBeenCalledWith(1, 0, 'ZPlus');
  });

  it('previews the side a button would add to, and clears the preview', () => {
    state = singleCubeState();
    selection.toggleHex(1, 0);

    component.previewFace('YMinus');
    expect(selection.hoverFace(1)).toEqual({ hex: 0, face: 'YMinus' });
    component.previewFace(null);
    expect(selection.hoverFace(1)).toBeNull();
  });

  it('previews nothing unless exactly one cube is picked', () => {
    state = linkedPairState();
    selection.toggleHex(1, 0);
    selection.toggleHex(1, 1);

    component.previewFace('YMinus');

    expect(selection.hoverFace(1)).toBeNull();
  });

  it('links the second picked cube to the first, which is the base', () => {
    state = { ...linkedPairState(), links: [] };
    selection.toggleHex(1, 1);
    selection.toggleHex(1, 0);

    expect(component.selectedHexes()).toEqual([1, 0]);
    expect(component.canLink()).toBeTrue();
    component.link();

    expect(editor.linkHexes).toHaveBeenCalledWith(1, 1, 0, true);
    expect(selection.hexes(1)).toEqual([]);
  });

  it('swap exchanges base and adapting cube before the link goes out', () => {
    state = { ...linkedPairState(), links: [] };
    selection.toggleHex(1, 1);
    selection.toggleHex(1, 0);

    expect(component.canSwap()).toBeTrue();
    component.swap();
    component.adaptSecond = false;
    component.link();

    expect(editor.linkHexes).toHaveBeenCalledWith(1, 0, 1, false);
  });

  it('cannot swap or link with fewer than two cubes', () => {
    state = singleCubeState();
    expect(component.canSwap()).toBeFalse();
    expect(component.canLink()).toBeFalse();
    selection.toggleHex(1, 0);
    expect(component.canSwap()).toBeFalse();
    expect(component.canLink()).toBeFalse();
  });

  it('cannot link cubes that are already neighbours, but can unlink them through their link', () => {
    state = linkedPairState();
    selection.toggleHex(1, 1);
    selection.toggleHex(1, 0);

    expect(component.canLink()).toBeFalse();
    expect(component.pairStatusText()).toBe('вже сусіди');
    expect(component.canUnlink()).toBeTrue();
    component.unlink();

    expect(editor.unlinkFace).toHaveBeenCalledWith(1, 0, 'XPlus');
    expect(selection.hexes(1)).toEqual([]);
  });

  it('says whether the two picked cubes are neighbours yet', () => {
    state = { ...linkedPairState(), links: [] };
    selection.toggleHex(1, 0);
    selection.toggleHex(1, 1);

    expect(component.pairStatusText()).toBe('ще не сусіди');
  });

  describe('cubes that cannot be neighbours', () => {
    // linkedPairState has cubes 0 (cell 0,0,0) and 1 (cell 1,0,0); move cube 1's cell to test relations.
    const withCell = (cell: [number, number, number]) => {
      const base = linkedPairState();
      state = { ...base, links: [], hexes: base.hexes.map(h => (h.id === 1 ? { ...h, cellI: cell[0], cellJ: cell[1], cellK: cell[2] } : h)) };
      selection.toggleHex(1, 0);
      selection.toggleHex(1, 1);
    };

    it('neighbouring cells can be linked', () => {
      withCell([1, 0, 0]);

      expect(component.pairRelation()).toBe('face');
      expect(component.canLink()).toBeTrue();
      expect(component.pairAdvice()).toBe('');
    });

    it('cubes touching only along an edge cannot, and the panel says what to do', () => {
      withCell([1, 1, 0]);

      expect(component.pairRelation()).toBe('edge');
      expect(component.canLink()).toBeFalse();
      expect(component.pairStatusText()).toContain('лише ребром');
      expect(component.pairAdvice()).toContain('додайте між ними куб');
    });

    it('cubes touching only at a corner cannot either', () => {
      withCell([1, 1, 1]);

      expect(component.pairRelation()).toBe('corner');
      expect(component.canLink()).toBeFalse();
      expect(component.pairStatusText()).toContain('лише вершиною');
    });

    it('cubes further apart than one cell cannot', () => {
      withCell([3, 0, 0]);

      expect(component.pairRelation()).toBe('far');
      expect(component.canLink()).toBeFalse();
      expect(component.pairStatusText()).toContain('не поруч');
    });

    it('has no relation unless exactly two known cubes are picked', () => {
      state = linkedPairState();
      selection.toggleHex(1, 0);
      expect(component.pairRelation()).toBeNull();
      expect(component.pairStatusText()).toBe('');
    });
  });

  it('summarises the neighbours of a cube', () => {
    state = linkedPairState();

    expect(component.neighborsText(0)).toBe('сусіди: 1');
    state = singleCubeState();
    expect(component.neighborsText(0)).toBe('сусідів немає');
  });

  it('lists cubes that touch without being neighbours once per pair, and links one on request', () => {
    const base = linkedPairState();
    state = {
      ...base,
      links: [],
      faces: base.faces.map((f): MeshFaceDto => (f.status === 'Linked' ? { ...f, status: 'Candidate', coincident: true, gap: 0 } : f))
    };

    const candidates = component.candidates();
    expect(candidates.length).toBe(1);
    expect(candidates[0]).toEqual({ a: 0, b: 1, text: 'грані збігаються' });

    component.linkCandidate(candidates[0]);
    expect(editor.linkHexes).toHaveBeenCalledWith(1, 0, 1, true);
  });

  it('shows the gap of a candidate pair whose faces have drifted apart', () => {
    const base = linkedPairState();
    state = {
      ...base,
      links: [],
      faces: base.faces.map((f): MeshFaceDto => (f.status === 'Linked' ? { ...f, status: 'Candidate', coincident: false, gap: 0.25 } : f))
    };

    expect(component.candidates()[0].text).toBe('зазор 0.250');
  });

  it('gives each candidate pair a stable identity so its row is not re-created on every pass', () => {
    expect(component.trackCandidate(0, { a: 2, b: 3 })).toBe('2-3');
    expect(component.trackCandidate(5, { a: 2, b: 3 })).toBe(component.trackCandidate(0, { a: 2, b: 3 }));
  });

  it('has no candidates for a mesh without unlinked neighbours', () => {
    state = linkedPairState();
    expect(component.candidates()).toEqual([]);
  });

  it('deletes the picked cube, only when exactly one cube is picked', () => {
    state = linkedPairState();
    expect(component.canRemove()).toBeFalse();

    selection.toggleHex(1, 1);
    expect(component.canRemove()).toBeTrue();
    component.remove();
    expect(editor.removeHex).toHaveBeenCalledWith(1, 1);
    expect(selection.hexes(1)).toEqual([]);

    selection.toggleHex(1, 0);
    selection.toggleHex(1, 1);
    expect(component.canRemove()).toBeFalse();
    editor.removeHex.calls.reset();
    component.remove();
    expect(editor.removeHex).not.toHaveBeenCalled();
  });

  it('cannot delete or attach while a command is running', () => {
    state = singleCubeState();
    selection.toggleHex(1, 0);
    busy.set(true);

    expect(component.canRemove()).toBeFalse();
    expect(component.canAttach('XPlus')).toBeFalse();
  });

  it('moves a selected node only in the Real World', () => {
    state = singleCubeState();
    selection.selectNode(1, 6);

    expect(component.canMoveNode()).toBeTrue();
    component.worldIndex = IDEAL_WORLD_INDEX;
    expect(component.canMoveNode()).toBeFalse();
    component.nudge('x', 1);
    expect(editor.moveNode).not.toHaveBeenCalled();
  });

  it('nudges by the step along one axis and keeps the other coordinates', () => {
    state = singleCubeState();
    selection.selectNode(1, 6); // corner (1, 1, 1)
    component.nudgeStep = 0.25;

    component.nudge('y', -1);

    expect(editor.moveNode).toHaveBeenCalledWith(1, 6, { x: 1, y: 0.75, z: 1 }, false);
  });

  it('sets one coordinate from the input and ignores non-numbers', () => {
    state = singleCubeState();
    selection.selectNode(1, 6);
    component.carryEdgeMidpoints = true;

    component.onCoordChange('z', { target: { value: '1.4' } } as unknown as Event);
    expect(editor.moveNode).toHaveBeenCalledWith(1, 6, { x: 1, y: 1, z: 1.4 }, true);

    editor.moveNode.calls.reset();
    component.onCoordChange('z', { target: { value: 'abc' } } as unknown as Event);
    expect(editor.moveNode).not.toHaveBeenCalled();
  });

  it('keeps the nudge step positive', () => {
    component.onNudgeStepChange({ target: { value: '-3' } } as unknown as Event);
    expect(component.nudgeStep).toBe(0.1);
    component.onNudgeStepChange({ target: { value: '0.5' } } as unknown as Event);
    expect(component.nudgeStep).toBe(0.5);
  });

  it('asks twice before resetting the mesh', () => {
    state = singleCubeState();

    component.requestReset();
    expect(editor.reset).not.toHaveBeenCalled();
    component.cancelReset();
    expect(component.isResetConfirming).toBeFalse();

    component.requestReset();
    component.confirmReset();
    expect(editor.reset).toHaveBeenCalledWith(1);
    expect(solver.forget).toHaveBeenCalledWith(1);     // the old cubes' supports and loads are gone on the server
  });

  it('reports the mapping probe result, and "outside" when nothing was found', () => {
    editor.mapIdealToReal.and.returnValue(of({ found: true, point: { x: 1, y: 2, z: 3 } }));
    editor.mapRealToIdeal.and.returnValue(of({ found: false, point: null }));

    component.probeIdealToReal();
    expect(component.mappingResult).toBe('Real: (1.0000, 2.0000, 3.0000)');
    component.probeRealToIdeal();
    expect(component.mappingResult).toBe('Поза тілом');
  });

  it('forwards undo/redo and exposes their availability', () => {
    state = { ...singleCubeState(), canUndo: true, canRedo: false };

    expect(component.canUndo()).toBeTrue();
    expect(component.canRedo()).toBeFalse();
    component.undo();
    component.redo();

    expect(editor.undo).toHaveBeenCalledWith(1);
    expect(editor.redo).toHaveBeenCalledWith(1);
  });

  it('does nothing without a session', () => {
    component.sessionId = null;

    component.addFirst();
    component.undo();
    component.confirmReset();

    expect(editor.addFirstHex).not.toHaveBeenCalled();
    expect(editor.undo).not.toHaveBeenCalled();
    expect(editor.reset).not.toHaveBeenCalled();
    expect(solver.forget).not.toHaveBeenCalled();
    expect(component.hexCount()).toBe(0);
  });

  describe('picked face', () => {
    it('describes the face and offers a cube on it only while it is free', () => {
      state = linkedPairState();
      selection.selectFace(1, { hex: 0, face: 'YPlus' });
      expect(component.activeFaceText()).toBe('Куб 0 · Y+ — вільна');
      expect(component.canAttachActiveFace()).toBeTrue();

      selection.selectFace(1, { hex: 0, face: 'XPlus' });
      expect(component.activeFaceText()).toContain("з'єднана з кубом 1");
      expect(component.canAttachActiveFace()).toBeFalse();
    });

    it('builds a cube on the picked face and clears the selection', () => {
      state = singleCubeState();
      selection.selectFace(1, { hex: 0, face: 'ZPlus' });

      component.attachActiveFace();

      expect(editor.addHexOnFace).toHaveBeenCalledWith(1, 0, 'ZPlus');
      expect(selection.face(1)).toBeNull();
    });

    it('deletes the cube of the picked face; with a cube picked instead, that cube', () => {
      state = linkedPairState();
      selection.selectFace(1, { hex: 1, face: 'YPlus' });
      expect(component.removeTarget()).toBe(1);

      selection.toggleHex(1, 0);                       // picking a cube drops the face
      expect(component.activeFace()).toBeNull();
      expect(component.removeTarget()).toBe(0);

      selection.toggleHex(1, 1);
      expect(component.removeTarget()).toBeNull();     // two cubes picked: ambiguous
      expect(component.canRemove()).toBeFalse();
    });
  });

  describe('keyboard shortcuts', () => {
    const press = (key: string, init: KeyboardEventInit = {}, target?: Element) => {
      const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
      if (target) Object.defineProperty(event, 'target', { value: target });
      component.onKeyDown(event);
      return event;
    };

    it('C opens the cube constructor window', () => {
      const event = press('c');

      expect(constructorWindow.open).toHaveBeenCalled();
      expect(event.defaultPrevented).toBeTrue();
    });

    it('the constructor is not opened without a session', () => {
      component.sessionId = null;

      component.openConstructor();

      expect(constructorWindow.open).not.toHaveBeenCalled();
    });

    it('A adds a cube on the picked face', () => {
      state = singleCubeState();
      selection.selectFace(1, { hex: 0, face: 'XPlus' });

      const event = press('a');

      expect(editor.addHexOnFace).toHaveBeenCalledWith(1, 0, 'XPlus');
      expect(event.defaultPrevented).toBeTrue();
    });

    it('does nothing, but still swallows the key, when the command is not available', () => {
      state = singleCubeState();

      const event = press('a');

      expect(editor.addHexOnFace).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBeTrue();   // a handled key even if disabled: no stray page action
    });

    it('Delete and Backspace delete the target cube', () => {
      state = linkedPairState();
      selection.toggleHex(1, 1);
      press('Delete');
      expect(editor.removeHex).toHaveBeenCalledWith(1, 1);

      selection.toggleHex(1, 0);
      press('Backspace');
      expect(editor.removeHex).toHaveBeenCalledWith(1, 0);
    });

    it('L links the picked pair, S swaps the roles first, U unlinks', () => {
      state = { ...linkedPairState(), links: [] };
      selection.toggleHex(1, 1);
      selection.toggleHex(1, 0);

      press('s');
      expect(selection.hexes(1)).toEqual([0, 1]);
      press('l');
      expect(editor.linkHexes).toHaveBeenCalledWith(1, 0, 1, true);

      state = linkedPairState();
      selection.toggleHex(1, 0);
      selection.toggleHex(1, 1);
      press('u');
      expect(editor.unlinkFace).toHaveBeenCalledWith(1, 0, 'XPlus');
    });

    it('N adds the first cube to an empty mesh only', () => {
      state = emptyState;
      press('n');
      expect(editor.addFirstHex).toHaveBeenCalledWith(1);

      editor.addFirstHex.calls.reset();
      state = singleCubeState();
      press('n');
      expect(editor.addFirstHex).not.toHaveBeenCalled();
    });

    it('Escape clears the selection', () => {
      state = singleCubeState();
      selection.selectFace(1, { hex: 0, face: 'XPlus' });
      selection.selectNode(1, 3);

      press('Escape');

      expect(selection.hexes(1)).toEqual([]);
      expect(selection.face(1)).toBeNull();
    });

    it('leaves Ctrl/Cmd+Z to the whole app (the global shortcuts), and does not undo twice', () => {
      state = { ...singleCubeState(), canUndo: true, canRedo: true };

      press('z', { ctrlKey: true });
      press('z', { metaKey: true, shiftKey: true });

      expect(editor.undo).not.toHaveBeenCalled();
      expect(editor.redo).not.toHaveBeenCalled();
    });

    it('arrow keys and PageUp/PageDown move the selected node, Shift multiplies by ten', () => {
      state = singleCubeState();
      selection.selectNode(1, 6);   // corner (1, 1, 1)
      component.nudgeStep = 0.1;

      press('ArrowRight');
      expect(editor.moveNode).toHaveBeenCalledWith(1, 6, { x: 1.1, y: 1, z: 1 }, false);
      press('ArrowUp');
      expect(editor.moveNode).toHaveBeenCalledWith(1, 6, { x: 1, y: 1, z: 0.9 }, false);
      press('PageDown', { shiftKey: true });
      expect(editor.moveNode).toHaveBeenCalledWith(1, 6, { x: 1, y: 0, z: 1 }, false);
    });

    it('arrow keys do nothing without a selected node or outside the Real World', () => {
      state = singleCubeState();
      press('ArrowRight');
      expect(editor.moveNode).not.toHaveBeenCalled();

      selection.selectNode(1, 6);
      component.worldIndex = IDEAL_WORLD_INDEX;
      press('ArrowRight');
      expect(editor.moveNode).not.toHaveBeenCalled();
    });

    it('ignores keys typed into an input, and unrelated or browser-modified keys', () => {
      state = singleCubeState();
      selection.selectFace(1, { hex: 0, face: 'XPlus' });

      const input = document.createElement('input');
      const typed = press('a', {}, input);
      expect(typed.defaultPrevented).toBeFalse();
      expect(editor.addHexOnFace).not.toHaveBeenCalled();

      expect(press('a', { ctrlKey: true }).defaultPrevented).toBeFalse();   // Ctrl+A is select-all
      expect(press('q').defaultPrevented).toBeFalse();
      expect(editor.addHexOnFace).not.toHaveBeenCalled();
    });

    it('does nothing without a session', () => {
      component.sessionId = null;

      expect(press('n').defaultPrevented).toBeFalse();
      expect(editor.addFirstHex).not.toHaveBeenCalled();
    });
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

    it('does nothing without a session', () => {
      const sessions = TestBed.inject(SessionsService);
      const before = sessions.sessions().map(s => s.id);
      component.sessionId = null;

      component.confirmRestart();

      expect(sessions.sessions().map(s => s.id)).toEqual(before);
    });
  });

  describe('inner grid setting', () => {
    const type = (axis: number, value: string) => component.onDivisionChange(axis, { target: { value } } as unknown as Event);

    it('shows the divisions of the solver, per axis', () => {
      expect(component.divisions()).toEqual([1, 2, 3]);
    });

    it('sends one changed axis with the others kept, clamped to 1..8, ignoring non-numbers', () => {
      type(0, '4');
      type(1, '99');
      type(2, '0');
      type(0, '2.9');
      type(1, 'abc');

      expect(solver.setDivisions.calls.allArgs()).toEqual([[1, 4, 2, 3], [1, 1, 8, 3], [1, 1, 2, 1], [1, 2, 2, 3]]);
    });

    it('does nothing without a session', () => {
      component.sessionId = null;

      type(0, '4');

      expect(solver.setDivisions).not.toHaveBeenCalled();
      expect(component.divisions()).toEqual([1, 1, 1]);
    });
  });

  describe('shortcuts popup', () => {
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
      component.onKeyDown(event);
      return event;
    };

    it('starts closed and the info button toggles it', () => {
      expect(component.isHelpOpen).toBeFalse();
      component.toggleHelp();
      expect(component.isHelpOpen).toBeTrue();
      component.closeHelp();
      expect(component.isHelpOpen).toBeFalse();
    });

    it('? opens and closes it', () => {
      expect(press('?').defaultPrevented).toBeTrue();
      expect(component.isHelpOpen).toBeTrue();
      press('?');
      expect(component.isHelpOpen).toBeFalse();
    });

    it('Escape closes the popup first and leaves the selection alone', () => {
      state = singleCubeState();
      selection.toggleHex(1, 0);
      component.toggleHelp();

      press('Escape');
      expect(component.isHelpOpen).toBeFalse();
      expect(selection.hexes(1)).toEqual([0]);

      press('Escape');
      expect(selection.hexes(1)).toEqual([]);
    });

    it('lists every key the handler reacts to', () => {
      const keys = SHORTCUTS.map(s => s.keys).join(' | ');

      for (const expected of ['N', 'A', 'L', 'U', 'S', 'Delete', 'Esc', 'Ctrl/Cmd + Z', 'Shift', '?']) {
        expect(keys).toContain(expected);
      }
      expect(component.shortcuts).toBe(SHORTCUTS);
    });
  });

  describe('numbering: local <-> global', () => {
    it('lists the 20 local nodes of the inspected cube with their coordinates and global ids', () => {
      state = linkedPairState();
      selection.toggleHex(1, 1);                       // cube 1: its XMinus face nodes are cube 0's

      const rows = component.numberingRows();

      expect(component.inspectedHex()).toBe(1);
      expect(rows.length).toBe(20);
      expect(rows[0]).toEqual(jasmine.objectContaining({ local: 0, kind: 'кут', alpha: -1, beta: -1, gamma: -1 }));
      expect(rows[8]).toEqual(jasmine.objectContaining({ local: 8, kind: 'середина ребра', alpha: 0, beta: -1, gamma: -1 }));
      expect(rows[19]).toEqual(jasmine.objectContaining({ local: 19, alpha: -1, beta: 1, gamma: 0 }));
      // local 0 of cube 1 is the corner (+,-,-) of cube 0, i.e. cube 0's local node 1
      expect(rows[0].node).toBe(linkedPairState().hexes[0].nodeIds[1]);
      expect(rows[0].x).toBe(1);
    });

    it('shows nothing when no cube is inspected', () => {
      state = singleCubeState();
      expect(component.inspectedHex()).toBeNull();
      expect(component.numberingRows()).toEqual([]);
    });

    it('inspects the cube of a picked face too', () => {
      state = singleCubeState();
      selection.selectFace(1, { hex: 0, face: 'XPlus' });

      expect(component.inspectedHex()).toBe(0);
      expect(component.numberingRows().length).toBe(20);
    });

    it('tells, for a shared node, which local number it has in each cube that owns it', () => {
      state = linkedPairState();
      const shared = linkedPairState().hexes[0].nodeIds[1];
      selection.selectNode(1, shared);

      expect(component.nodeOwnersText()).toBe('куб 0: локальний №1 (кут); куб 1: локальний №0 (кут)');
    });

    it('a node owned by one cube has one entry, and no node selected gives an empty text', () => {
      state = singleCubeState();
      expect(component.nodeOwnersText()).toBe('');

      selection.selectNode(1, 8);
      expect(component.nodeOwnersText()).toBe('куб 0: локальний №8 (середина ребра)');
    });
  });
});
