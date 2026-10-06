import { TestBed } from '@angular/core/testing';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';

describe('MeshEditorSelectionService', () => {
  let selection: MeshEditorSelectionService;

  beforeEach(() => {
    selection = TestBed.inject(MeshEditorSelectionService);
  });

  it('starts empty', () => {
    expect(selection.faces(1)).toEqual([]);
    expect(selection.nodeId(1)).toBeNull();
    expect(selection.revision(1)).toBe(0);
  });

  it('toggles a face on and off', () => {
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    expect(selection.faces(1)).toEqual([{ hex: 0, face: 'XPlus' }]);
    expect(selection.isFaceSelected(1, { hex: 0, face: 'XPlus' })).toBeTrue();

    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    expect(selection.faces(1)).toEqual([]);
  });

  it('keeps the two newest faces: a third pick drops the oldest', () => {
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    selection.toggleFace(1, { hex: 1, face: 'XMinus' });
    selection.toggleFace(1, { hex: 2, face: 'YPlus' });

    expect(selection.faces(1)).toEqual([
      { hex: 1, face: 'XMinus' },
      { hex: 2, face: 'YPlus' }
    ]);
  });

  it('treats the same hex with a different face as a different face', () => {
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    selection.toggleFace(1, { hex: 0, face: 'XMinus' });

    expect(selection.faces(1).length).toBe(2);
  });

  it('selects and deselects a node by clicking it again', () => {
    selection.selectNode(1, 7);
    expect(selection.nodeId(1)).toBe(7);
    selection.selectNode(1, 8);
    expect(selection.nodeId(1)).toBe(8);
    selection.selectNode(1, 8);
    expect(selection.nodeId(1)).toBeNull();
  });

  it('bumps the revision on every change and keeps sessions apart', () => {
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    selection.selectNode(1, 3);

    expect(selection.revision(1)).toBe(2);
    expect(selection.faces(2)).toEqual([]);
    expect(selection.revision(2)).toBe(0);
  });

  it('clear drops faces and node', () => {
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    selection.selectNode(1, 3);

    selection.clear(1);

    expect(selection.faces(1)).toEqual([]);
    expect(selection.nodeId(1)).toBeNull();
  });

  it('retain drops only the picks that no longer exist, and does not bump when nothing changed', () => {
    selection.toggleFace(1, { hex: 0, face: 'XPlus' });
    selection.toggleFace(1, { hex: 5, face: 'XMinus' });
    selection.selectNode(1, 9);
    const before = selection.revision(1);

    selection.retain(1, () => true, () => true);
    expect(selection.revision(1)).toBe(before);

    selection.retain(1, hex => hex === 0, () => false);
    expect(selection.faces(1)).toEqual([{ hex: 0, face: 'XPlus' }]);
    expect(selection.nodeId(1)).toBeNull();
    expect(selection.revision(1)).toBe(before + 1);
  });
});
