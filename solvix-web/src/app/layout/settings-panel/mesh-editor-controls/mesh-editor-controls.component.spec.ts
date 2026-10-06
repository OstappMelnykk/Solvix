import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { MeshEditorControlsComponent } from './mesh-editor-controls.component';
import { MeshEditorService } from '../../../state/mesh-editor.service';
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

  const emptyState: MeshStateDto = { version: 0, canUndo: false, canRedo: false, nodes: [], hexes: [], links: [], faces: [], invalidHexes: [] };

  beforeEach(() => {
    state = emptyState;
    busy = signal(false);
    editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', [
      'getState', 'addFirstHex', 'addHexOnFace', 'linkFaces', 'linkHexes', 'unlinkFace', 'moveNode', 'undo', 'redo', 'reset', 'mapIdealToReal', 'mapRealToIdeal'
    ]);
    editor.getState.and.callFake(() => state);
    editor.carryEdgeMidpoints = true;
    Object.defineProperty(editor, 'busy', { get: () => busy });
    TestBed.configureTestingModule({ providers: [{ provide: MeshEditorService, useValue: editor }] });
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

  it('lets a single free face receive a cube, and clears the selection afterwards', () => {
    state = singleCubeState();
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });

    expect(component.canAttach()).toBeTrue();
    component.attach();

    expect(editor.addHexOnFace).toHaveBeenCalledWith(1, 0, 'XPlus');
    expect(selection.faces(1)).toEqual([]);
  });

  it('does not offer attaching to a linked face, but offers unlinking it', () => {
    state = linkedPairState();
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });

    expect(component.canAttach()).toBeFalse();
    expect(component.canUnlink()).toBeTrue();
    component.unlink();

    expect(editor.unlinkFace).toHaveBeenCalledWith(1, 0, 'XPlus');
  });

  it('links the two cubes of the picked faces in click order, whichever faces were clicked', () => {
    state = linkedPairState();
    state = { ...state, links: [] };
    selection.toggleFace(1, { hex: 1, face: 'YPlus' });
    selection.toggleFace(1, { hex: 0, face: 'ZMinus' });

    expect(component.selectedHexes()).toEqual([1, 0]);
    expect(component.canLink()).toBeTrue();
    component.link();
    expect(editor.linkHexes).toHaveBeenCalledWith(1, 1, 0, true);
    expect(selection.faces(1)).toEqual([]);

    selection.toggleFace(1, { hex: 1, face: 'YPlus' });
    selection.toggleFace(1, { hex: 0, face: 'ZMinus' });
    component.adaptSecond = false;
    component.link();
    expect(editor.linkHexes).toHaveBeenCalledWith(1, 1, 0, false);
  });

  it('counts a cube once even when two of its faces are picked, so that is not a pair', () => {
    state = singleCubeState();
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    selection.toggleFace(1, { hex: 0, face: 'YPlus' });

    expect(component.selectedHexes()).toEqual([0]);
    expect(component.canLink()).toBeFalse();
  });

  it('cannot link cubes that are already neighbours, but can unlink them through their link', () => {
    state = linkedPairState();
    selection.toggleFace(1, { hex: 0, face: 'YPlus' });
    selection.toggleFace(1, { hex: 1, face: 'YPlus' });

    expect(component.canLink()).toBeFalse();
    expect(component.pairStatusText()).toBe('вже сусіди');
    expect(component.canUnlink()).toBeTrue();
    component.unlink();

    expect(editor.unlinkFace).toHaveBeenCalledWith(1, 0, 'XPlus');
    expect(selection.faces(1)).toEqual([]);
  });

  it('cannot link fewer than two cubes', () => {
    state = singleCubeState();
    expect(component.canLink()).toBeFalse();
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    expect(component.canLink()).toBeFalse();
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

  it('has no candidates for a mesh without unlinked neighbours', () => {
    state = linkedPairState();
    expect(component.candidates()).toEqual([]);
  });

  it('describes a face: free, linked and a candidate with its gap', () => {
    const candidate: MeshFaceDto = { hex: 0, face: 'XPlus', status: 'Candidate', otherHex: 3, otherFace: 'XMinus', coincident: false, gap: 0.3 };
    state = { ...singleCubeState(), faces: [candidate, ...singleCubeState().faces.filter(f => f.face !== 'XPlus')] };

    expect(component.faceStatusText({ hex: 0, face: 'XMinus' })).toBe('вільна');
    expect(component.faceStatusText({ hex: 0, face: 'XPlus' })).toContain('зазор 0.300');
    state = linkedPairState();
    expect(component.faceStatusText({ hex: 0, face: 'XPlus' })).toContain("з'єднана з кубом 1");
    expect(component.faceLabel({ hex: 2, face: 'YMinus' })).toBe('Куб 2 · Y−');
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

    expect(editor.moveNode).toHaveBeenCalledWith(1, 6, { x: 1, y: 0.75, z: 1 }, true);
  });

  it('sets one coordinate from the input and ignores non-numbers', () => {
    state = singleCubeState();
    selection.selectNode(1, 6);
    component.carryEdgeMidpoints = false;

    component.onCoordChange('z', { target: { value: '1.4' } } as unknown as Event);
    expect(editor.moveNode).toHaveBeenCalledWith(1, 6, { x: 1, y: 1, z: 1.4 }, false);

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
    expect(component.hexCount()).toBe(0);
  });
});
