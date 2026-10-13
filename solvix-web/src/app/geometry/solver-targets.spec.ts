import { MeshStateDto } from '../api/mesh-editor-api.service';
import { PickedFace } from './mesh-editor-view';
import { FACE_SCOPES, MATERIAL_SCOPES, elementAtDepth, elementTargets, faceTargets, sameFace, smallFacesOf, tangentAxes } from './solver-targets';
import { linkedPairState } from './mesh-state.fixture.spec';

const pick = (over: Partial<PickedFace> = {}): PickedFace => ({ kind: 'face', hex: 0, face: 'XMinus', p: 1, q: 2, element: [0, 1, 2], inner: false, ...over });

describe('solver-targets', () => {
  it('lists the scopes each kind of tool offers', () => {
    expect(FACE_SCOPES).toEqual(['cell', 'cube', 'side']);
    expect(MATERIAL_SCOPES).toEqual(['cell', 'column', 'layer', 'cube']);
  });

  it('the tangent axes of a face are the other two, lower first', () => {
    expect(tangentAxes('XPlus')).toEqual([1, 2]);
    expect(tangentAxes('YMinus')).toEqual([0, 2]);
    expect(tangentAxes('ZPlus')).toEqual([0, 1]);
  });

  describe('face targets', () => {
    const state: MeshStateDto = linkedPairState();

    it('"cell" is the small face that was hit', () => {
      expect(faceTargets(pick(), 'cell', state, [2, 3, 4])).toEqual([{ hex: 0, face: 'XMinus', p: 1, q: 2 }]);
    });

    it('"cube" is the whole side of that cube', () => {
      expect(faceTargets(pick(), 'cube', state, [2, 3, 4])).toEqual([{ hex: 0, face: 'XMinus' }]);
    });

    it('"side" is every outer face with that name, and none of the faces inside the body', () => {
      expect(faceTargets(pick({ face: 'YPlus' }), 'side', state, [1, 1, 1])).toEqual([{ hex: 0, face: 'YPlus' }, { hex: 1, face: 'YPlus' }]);
      expect(faceTargets(pick({ hex: 1, face: 'XPlus' }), 'side', state, [1, 1, 1])).toEqual([{ hex: 1, face: 'XPlus' }]);   // cube 0's XPlus is linked
    });

    it('a pick without a cell stands for the whole face', () => {
      expect(faceTargets({ kind: 'face', hex: 3, face: 'ZPlus' }, 'cell', state, [1, 1, 1])).toEqual([{ hex: 3, face: 'ZPlus' }]);
    });

    it('"side" falls back to the face itself when the state has nothing for it', () => {
      expect(faceTargets(pick({ face: 'XMinus', hex: 7 }), 'side', null, [1, 1, 1])).toEqual([{ hex: 7, face: 'XMinus' }]);
    });
  });

  describe('the element at a depth', () => {
    it('goes inward: +axis from a face on the minus side, -axis from one on the plus side', () => {
      expect(elementAtDepth(pick({ face: 'XMinus', element: [0, 1, 2] }), 0, [3, 3, 4])).toEqual([0, 1, 2]);
      expect(elementAtDepth(pick({ face: 'XMinus', element: [0, 1, 2] }), 2, [3, 3, 4])).toEqual([2, 1, 2]);
      expect(elementAtDepth(pick({ face: 'ZPlus', element: [1, 1, 3] }), 3, [3, 3, 4])).toEqual([1, 1, 0]);
    });

    it('is null beyond the cube, and without a pick of an element', () => {
      expect(elementAtDepth(pick({ face: 'XMinus', element: [0, 0, 0] }), 3, [3, 3, 3])).toBeNull();
      expect(elementAtDepth(pick({ face: 'XPlus', element: [2, 0, 0] }), 3, [3, 3, 3])).toBeNull();
      expect(elementAtDepth({ kind: 'face', hex: 0, face: 'XMinus' }, 0, [3, 3, 3])).toBeNull();
    });

    it('works from a face between elements: an inner face of the visible element behind it', () => {
      // the visible element is the one whose Plus face was hit, so inward is -axis
      expect(elementAtDepth(pick({ face: 'YPlus', element: [1, 2, 0], inner: true }), 1, [3, 3, 3])).toEqual([1, 1, 0]);
    });
  });

  describe('element targets', () => {
    const divisions = [3, 2, 2];

    it('"cell" is one element at the chosen depth below the face', () => {
      expect(elementTargets(pick({ face: 'XMinus', element: [0, 1, 0] }), 'cell', 0, divisions)).toEqual([{ hex: 0, ex: 0, ey: 1, ez: 0 }]);
      expect(elementTargets(pick({ face: 'XMinus', element: [0, 1, 0] }), 'cell', 2, divisions)).toEqual([{ hex: 0, ex: 2, ey: 1, ez: 0 }]);
    });

    it('nothing is targeted beyond the cube', () => {
      expect(elementTargets(pick({ face: 'XMinus', element: [0, 1, 0] }), 'cell', 3, divisions)).toEqual([]);
      expect(elementTargets(pick({ face: 'XMinus', element: [0, 1, 0] }), 'layer', 3, divisions)).toEqual([]);
    });

    it('"column" is every element below the face, from the surface to the far side', () => {
      const column = elementTargets(pick({ face: 'XPlus', element: [2, 0, 1] }), 'column', 0, divisions);

      expect(column).toEqual([{ hex: 0, ex: 2, ey: 0, ez: 1 }, { hex: 0, ex: 1, ey: 0, ez: 1 }, { hex: 0, ex: 0, ey: 0, ez: 1 }]);
    });

    it('"layer" is the whole slab of the cube at the depth, parallel to the face', () => {
      const layer = elementTargets(pick({ face: 'XMinus', element: [0, 1, 0] }), 'layer', 1, divisions);

      expect(layer.length).toBe(2 * 2);                                 // ny * nz elements
      expect(layer.every(e => e.ex === 1)).toBeTrue();
      expect(new Set(layer.map(e => `${e.ey},${e.ez}`)).size).toBe(4);
    });

    it('"cube" is every element of the cube', () => {
      const cube = elementTargets(pick(), 'cube', 0, divisions);

      expect(cube.length).toBe(3 * 2 * 2);
      expect(new Set(cube.map(e => `${e.ex},${e.ey},${e.ez}`)).size).toBe(12);
    });

    it('without a hit element there is nothing to target', () => {
      expect(elementTargets({ kind: 'face', hex: 0, face: 'XMinus' }, 'cube', 0, divisions)).toEqual([]);
    });
  });

  describe('small faces', () => {
    it('a whole side is all of its small faces; one cell is itself', () => {
      expect(smallFacesOf({ hex: 1, face: 'XPlus' }, [2, 2, 3]).map(f => [f.p, f.q])).toEqual([[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
      expect(smallFacesOf({ hex: 1, face: 'XPlus', p: 1, q: 1 }, [2, 2, 3])).toEqual([{ hex: 1, face: 'XPlus', p: 1, q: 1 }]);
    });

    it('compares faces by cube, side and cell', () => {
      expect(sameFace({ hex: 1, face: 'XPlus', p: 1, q: 0 }, { hex: 1, face: 'XPlus', p: 1, q: 0 })).toBeTrue();
      expect(sameFace({ hex: 1, face: 'XPlus', p: 1, q: 0 }, { hex: 1, face: 'XPlus', p: 0, q: 0 })).toBeFalse();
      expect(sameFace({ hex: 1, face: 'XPlus' }, { hex: 1, face: 'XPlus' })).toBeTrue();
      expect(sameFace({ hex: 1, face: 'XPlus' }, { hex: 1, face: 'XMinus' })).toBeFalse();
    });
  });
});
