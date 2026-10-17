import { TestBed } from '@angular/core/testing';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';

describe('MeshEditorSelectionService', () => {
  let selection: MeshEditorSelectionService;

  beforeEach(() => {
    selection = TestBed.inject(MeshEditorSelectionService);
  });

  it('starts empty', () => {
    expect(selection.hexes(1)).toEqual([]);
    expect(selection.face(1)).toBeNull();
    expect(selection.nodeId(1)).toBeNull();
    expect(selection.hoverFace(1)).toBeNull();
    expect(selection.revision(1)).toBe(0);
  });

  it('keeps cubes in pick order: the first is the base', () => {
    selection.toggleHex(1, 4);
    selection.toggleHex(1, 2);

    expect(selection.hexes(1)).toEqual([4, 2]);
    expect(selection.isHexSelected(1, 4)).toBeTrue();
    expect(selection.isHexSelected(1, 9)).toBeFalse();
  });

  it('clicking a picked cube deselects it, and the other becomes the base', () => {
    selection.toggleHex(1, 4);
    selection.toggleHex(1, 2);

    selection.toggleHex(1, 4);

    expect(selection.hexes(1)).toEqual([2]);
  });

  it('a third cube replaces the second, so the base stays', () => {
    selection.toggleHex(1, 4);
    selection.toggleHex(1, 2);
    selection.toggleHex(1, 7);

    expect(selection.hexes(1)).toEqual([4, 7]);
  });

  it('swaps base and adapting cube, only when two are picked', () => {
    selection.toggleHex(1, 4);
    selection.swapHexes(1);
    expect(selection.hexes(1)).toEqual([4]);
    const before = selection.revision(1);

    selection.toggleHex(1, 2);
    selection.swapHexes(1);

    expect(selection.hexes(1)).toEqual([2, 4]);
    expect(selection.revision(1)).toBe(before + 2);
    selection.swapHexes(1);
    expect(selection.hexes(1)).toEqual([4, 2]);
  });

  it('picks an edge, drops the face and the cubes, and deselects it by picking it again', () => {
    selection.toggleHex(1, 4);
    selection.selectEdge(1, { hex: 4, edge: 7 });
    expect(selection.edge(1)).toEqual({ hex: 4, edge: 7 });
    expect(selection.hexes(1)).toEqual([]);

    selection.selectFace(1, { hex: 4, face: 'XPlus' });         // a face takes the place of the edge
    expect(selection.edge(1)).toBeNull();
    selection.applyPick(1, { kind: 'edge', hex: 2, edge: 3 }, false);
    expect(selection.edge(1)).toEqual({ hex: 2, edge: 3 });
    expect(selection.face(1)).toBeNull();
    selection.applyPick(1, { kind: 'edge', hex: 2, edge: 3 }, false);
    expect(selection.edge(1)).toBeNull();
  });

  it('picking a node lets go of the face or the edge, and taking the node off brings nothing back', () => {
    selection.selectFace(1, { hex: 0, face: 'XPlus' });
    selection.selectNode(1, 6);
    expect(selection.nodeId(1)).toBe(6);
    expect(selection.face(1)).toBeNull();

    selection.selectEdge(1, { hex: 0, edge: 4 });
    selection.selectNode(1, 7);
    expect(selection.edge(1)).toBeNull();

    selection.selectNode(1, 7);                                    // the same node again: deselected
    expect(selection.nodeId(1)).toBeNull();
    expect(selection.face(1)).toBeNull();
    expect(selection.edge(1)).toBeNull();
  });

  it('picking a face or an edge lets go of the picked node, so the arrows and the gizmo move what was picked last', () => {
    selection.selectNode(1, 6);
    selection.selectFace(1, { hex: 0, face: 'XPlus' });
    expect(selection.nodeId(1)).toBeNull();
    expect(selection.face(1)).toEqual({ hex: 0, face: 'XPlus' });

    selection.selectNode(1, 6);
    selection.selectEdge(1, { hex: 0, edge: 4 });
    expect(selection.nodeId(1)).toBeNull();
    expect(selection.edge(1)).toEqual({ hex: 0, edge: 4 });
  });

  it('forgets the edge of a cube that is gone, and a clear drops it', () => {
    selection.selectEdge(1, { hex: 4, edge: 7 });
    selection.retain(1, id => id !== 4, () => true);
    expect(selection.edge(1)).toBeNull();

    selection.selectEdge(1, { hex: 5, edge: 1 });
    selection.clear(1);
    expect(selection.edge(1)).toBeNull();
  });

  it('selects and deselects a node by clicking it again', () => {
    selection.selectNode(1, 7);
    expect(selection.nodeId(1)).toBe(7);
    selection.selectNode(1, 8);
    expect(selection.nodeId(1)).toBe(8);
    selection.selectNode(1, 8);
    expect(selection.nodeId(1)).toBeNull();
  });

  it('remembers the hovered face and does not bump the revision for the same one', () => {
    selection.setHoverFace(1, { hex: 0, face: 'XPlus' });
    const revision = selection.revision(1);

    selection.setHoverFace(1, { hex: 0, face: 'XPlus' });
    expect(selection.revision(1)).toBe(revision);
    selection.setHoverFace(1, null);
    expect(selection.hoverFace(1)).toBeNull();
    expect(selection.revision(1)).toBe(revision + 1);
  });

  it('bumps the revision on every change and keeps sessions apart', () => {
    selection.toggleHex(1, 0);
    selection.selectNode(1, 3);

    expect(selection.revision(1)).toBe(2);
    expect(selection.hexes(2)).toEqual([]);
    expect(selection.revision(2)).toBe(0);
  });

  it('clear drops cubes, node and hovered face', () => {
    selection.toggleHex(1, 0);
    selection.selectNode(1, 3);
    selection.setHoverFace(1, { hex: 0, face: 'YPlus' });

    selection.clear(1);

    expect(selection.hexes(1)).toEqual([]);
    expect(selection.nodeId(1)).toBeNull();
    expect(selection.hoverFace(1)).toBeNull();
  });

  it('retain drops only the picks that no longer exist, and does not bump when nothing changed', () => {
    selection.toggleHex(1, 0);
    selection.toggleHex(1, 5);
    selection.selectNode(1, 9);
    selection.setHoverFace(1, { hex: 5, face: 'XMinus' });
    const before = selection.revision(1);

    selection.retain(1, () => true, () => true);
    expect(selection.revision(1)).toBe(before);

    selection.retain(1, hex => hex === 0, () => false);
    expect(selection.hexes(1)).toEqual([0]);
    expect(selection.nodeId(1)).toBeNull();
    expect(selection.hoverFace(1)).toBeNull();
    expect(selection.revision(1)).toBe(before + 1);
  });

  it('picks one face, and clicking it again deselects it', () => {
    selection.selectFace(1, { hex: 2, face: 'XPlus' });
    expect(selection.face(1)).toEqual({ hex: 2, face: 'XPlus' });

    selection.selectFace(1, { hex: 3, face: 'YMinus' });
    expect(selection.face(1)).toEqual({ hex: 3, face: 'YMinus' });

    selection.selectFace(1, { hex: 3, face: 'YMinus' });
    expect(selection.face(1)).toBeNull();
  });

  it('a face and cubes are never picked at the same time: picking one kind drops the other', () => {
    selection.selectFace(1, { hex: 2, face: 'XPlus' });
    selection.toggleHex(1, 5);
    expect(selection.face(1)).toBeNull();
    expect(selection.hexes(1)).toEqual([5]);

    selection.toggleHex(1, 6);
    selection.selectFace(1, { hex: 2, face: 'XPlus' });
    expect(selection.hexes(1)).toEqual([]);
    expect(selection.face(1)).toEqual({ hex: 2, face: 'XPlus' });
  });

  it('deselecting the only picked cube leaves nothing picked, not a stale face', () => {
    selection.selectFace(1, { hex: 2, face: 'XPlus' });
    selection.toggleHex(1, 5);
    selection.toggleHex(1, 5);

    expect(selection.hexes(1)).toEqual([]);
    expect(selection.face(1)).toBeNull();
  });

  it('a node pick lets go of the face, but not of the picked cubes', () => {
    selection.selectFace(1, { hex: 2, face: 'XPlus' });
    selection.selectNode(1, 8);
    expect(selection.face(1)).toBeNull();

    selection.toggleHex(1, 3);
    selection.selectNode(1, 9);
    expect(selection.hexes(1)).toEqual([3]);
  });

  describe('applyPick', () => {
    const face = { kind: 'face' as const, hex: 4, face: 'ZPlus' as const };

    it('a plain click on a face picks the face', () => {
      selection.applyPick(1, face, false);

      expect(selection.face(1)).toEqual({ hex: 4, face: 'ZPlus' });
      expect(selection.hexes(1)).toEqual([]);
    });

    it('Shift+click on a face picks its cube, in pick order, and drops a picked face', () => {
      selection.selectFace(1, { hex: 9, face: 'XPlus' });

      selection.applyPick(1, face, true);
      selection.applyPick(1, { kind: 'face', hex: 7, face: 'XMinus' }, true);

      expect(selection.hexes(1)).toEqual([4, 7]);
      expect(selection.face(1)).toBeNull();
    });

    it('a plain click on a face drops picked cubes', () => {
      selection.toggleHex(1, 3);
      selection.toggleHex(1, 4);

      selection.applyPick(1, face, false);

      expect(selection.hexes(1)).toEqual([]);
      expect(selection.face(1)).toEqual({ hex: 4, face: 'ZPlus' });
    });

    it('a click on a node picks the node, with or without Shift', () => {
      selection.applyPick(1, { kind: 'node', nodeId: 12 }, false);
      expect(selection.nodeId(1)).toBe(12);
      selection.applyPick(1, { kind: 'node', nodeId: 13 }, true);
      expect(selection.nodeId(1)).toBe(13);
    });

    it('a plain click on empty space clears everything, Shift+click keeps it', () => {
      selection.applyPick(1, { kind: 'node', nodeId: 1 }, false);
      selection.toggleHex(1, 3);

      selection.applyPick(1, null, true);
      expect(selection.hexes(1)).toEqual([3]);
      expect(selection.nodeId(1)).toBe(1);

      selection.applyPick(1, null, false);
      expect(selection.hexes(1)).toEqual([]);
      expect(selection.face(1)).toBeNull();
      expect(selection.nodeId(1)).toBeNull();
    });
  });

  it('retain also drops a picked face whose cube is gone', () => {
    selection.selectFace(1, { hex: 5, face: 'XPlus' });

    selection.retain(1, hex => hex !== 5, () => true);

    expect(selection.face(1)).toBeNull();
  });

  it('keeps whether building with the mouse is on per session and World (off to begin with), and the nodes seen through the cubes (on)', () => {
    expect(selection.buildMode(1, 0)).toBeFalse();
    expect(selection.buildMode(1, 1)).toBeFalse();
    selection.setBuildMode(1, 0, true);
    selection.setBuildMode(1, 1, true);
    selection.setBuildMode(2, 1, true);
    expect(selection.buildMode(1, 0)).toBeTrue();
    expect(selection.buildMode(1, 1)).toBeTrue();
    expect(selection.buildMode(1, 3)).toBeFalse();            // nowhere else
    selection.setBuildMode(1, 1, false);
    expect(selection.buildMode(1, 1)).toBeFalse();
    expect(selection.buildMode(1, 0)).toBeTrue();             // the other World keeps its own
    expect(selection.buildMode(2, 1)).toBeTrue();             // and so does another session

    expect(selection.xrayNodes(1)).toBeTrue();
    const revision = selection.revision(1);
    selection.setXrayNodes(1, false);
    expect(selection.xrayNodes(1)).toBeFalse();
    expect(selection.revision(1)).toBe(revision + 1);              // the view is drawn again
    selection.setXrayNodes(1, false);
    expect(selection.revision(1)).toBe(revision + 1);
  });

  describe('several faces', () => {
    const a = { hex: 0, face: 'XPlus' as const };
    const b = { hex: 1, face: 'YPlus' as const };

    it('a plain click replaces the picked face', () => {
      selection.selectFace(1, a);
      selection.selectFace(1, b);

      expect(selection.faces(1)).toEqual([b]);
    });

    it('a together-click adds a face, and takes it away when it is picked', () => {
      selection.selectFace(1, a);
      selection.selectFace(1, b, true);
      expect(selection.faces(1)).toEqual([a, b]);
      expect(selection.face(1)).toEqual(b);

      selection.selectFace(1, a, true);
      expect(selection.faces(1)).toEqual([b]);
    });

    it('the switch makes a plain click add the face', () => {
      selection.setMultiFace(1, true);
      selection.applyPick(1, { kind: 'face', hex: 0, face: 'XPlus' } as never, false);
      selection.applyPick(1, { kind: 'face', hex: 1, face: 'YPlus' } as never, false);

      expect(selection.faces(1).length).toBe(2);
    });

    it('the brush picks every face it passes, once each, together with the picked ones', () => {
      selection.brushFace(1, a);
      selection.brushFace(1, b);
      const revision = selection.revision(1);
      selection.brushFace(1, a);                                         // already picked: nothing changes

      expect(selection.faces(1)).toEqual([a, b]);
      expect(selection.revision(1)).toBe(revision);
    });

    it('the brush is a switch per session', () => {
      expect(selection.isFaceBrush(1)).toBeFalse();
      selection.setFaceBrush(1, true);
      expect(selection.isFaceBrush(1)).toBeTrue();
      expect(selection.isFaceBrush(2)).toBeFalse();
    });

    it('picking a cube, a node or an edge lets go of all the faces', () => {
      selection.selectFace(1, a);
      selection.selectFace(1, b, true);

      selection.selectNode(1, 5);

      expect(selection.faces(1)).toEqual([]);
    });
  });
});
