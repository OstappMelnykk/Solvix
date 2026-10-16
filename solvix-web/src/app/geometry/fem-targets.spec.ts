import { SolverMeshDto } from '../api/solver-api.service';
import { femAllMarked, femElementTargets, femFaceTargets, femIndex, femRefineTargets } from './fem-targets';

// cubes 0 (elements a, b) and 1 (element c); the faces on the surface are a:5, b:5, c:5 and a:0
const mesh = {
  rule: 'local', nodeCount: 0, elementCount: 3, positions: [], connectivity: [], hexIds: [0, 0, 1], keys: ['a', 'b', 'c'], materials: ['', '', ''],
  surfaceFaces: [0, 5, 1, 5, 2, 5, 0, 0], fixedFaces: [1, 5], loadedFaces: [2, 5], pressures: [-1e6]
} as SolverMeshDto;
const index = femIndex(mesh);
const pick = (key: string, localFace: number, hex: number) => ({ kind: 'face' as const, hex, face: 'XPlus' as const, elementKey: key, localFace });

describe('what a click on a mesh of finite elements reaches', () => {
  it('a face is the one hit', () => {
    expect(femFaceTargets(pick('b', 5, 0), 'cell', mesh, index)).toEqual([{ key: 'b', face: 5 }]);
  });

  it('a side of a cube is every surface face of that cube on that side', () => {
    expect(femFaceTargets(pick('a', 5, 0), 'cube', mesh, index)).toEqual([{ key: 'a', face: 5 }, { key: 'b', face: 5 }]);
  });

  it('a side of the body is every surface face on that side, of any cube', () => {
    expect(femFaceTargets(pick('a', 5, 0), 'side', mesh, index).map(f => f.key)).toEqual(['a', 'b', 'c']);
  });

  it('an element is the one behind the face, or all of its cube', () => {
    expect(femElementTargets(pick('b', 5, 0), 'cell', mesh)).toEqual(['b']);
    expect(femElementTargets(pick('b', 5, 0), 'cube', mesh)).toEqual(['a', 'b']);
  });

  it('a pick of the even division reaches nothing here', () => {
    expect(femFaceTargets({ kind: 'face', hex: 0, face: 'XPlus', p: 0, q: 0 }, 'cell', mesh, index)).toEqual([]);
  });

  it('tells whether every face is clamped, or pressed with the very pressure', () => {
    expect(femAllMarked(mesh, index, [{ key: 'b', face: 5 }], 'fixed')).toBeTrue();
    expect(femAllMarked(mesh, index, [{ key: 'b', face: 5 }, { key: 'a', face: 5 }], 'fixed')).toBeFalse();
    expect(femAllMarked(mesh, index, [{ key: 'c', face: 5 }], 'loaded', -1e6)).toBeTrue();
    expect(femAllMarked(mesh, index, [{ key: 'c', face: 5 }], 'loaded', -2e6)).toBeFalse();
    expect(femAllMarked(mesh, index, [], 'fixed')).toBeFalse();
  });
});

describe('what the Refinement tool reaches', () => {
  // three elements stacked along z: a (bottom), b, c (top); each next one stands on the corner nodes the one below ends in
  const stack = (() => {
    const connectivity: number[] = [];
    for (let e = 0; e < 3; e++) {
      const slots = new Array(20).fill(0);
      for (let i = 0; i < 4; i++) { slots[i] = 4 * e + i; slots[4 + i] = 4 * (e + 1) + i; }
      connectivity.push(...slots);
    }
    return { rule: 'local', nodeCount: 16, elementCount: 3, positions: [], connectivity, hexIds: [0, 1, 1], keys: ['a', 'b', 'c'], materials: ['', '', ''], surfaceFaces: [], fixedFaces: [], loadedFaces: [], pressures: [] } as SolverMeshDto;
  })();
  const stackIndex = femIndex(stack);
  const hit = (key: string, face: number, hex: number) => ({ kind: 'face' as const, hex, face: 'ZMinus' as const, elementKey: key, localFace: face });

  it('one element, the row of them from the face inward, or the whole cube', () => {
    expect(femRefineTargets(hit('a', 0, 0), 'cell', stack, stackIndex)).toEqual(['a']);
    expect(femRefineTargets(hit('a', 0, 0), 'column', stack, stackIndex)).toEqual(['a', 'b', 'c']);
    expect(femRefineTargets(hit('c', 1, 1), 'column', stack, stackIndex)).toEqual(['c', 'b', 'a']);
    expect(femRefineTargets(hit('b', 0, 1), 'cube', stack, stackIndex)).toEqual(['b', 'c']);
  });

  it('one element that deep inward from the face, the deepest there is when the row is shorter', () => {
    expect(femRefineTargets(hit('a', 0, 0), 'cell', stack, stackIndex, 1)).toEqual(['b']);
    expect(femRefineTargets(hit('a', 0, 0), 'cell', stack, stackIndex, 2)).toEqual(['c']);
    expect(femRefineTargets(hit('a', 0, 0), 'cell', stack, stackIndex, 9)).toEqual(['c']);
  });

  it('stops where the row ends, and finds nothing for a pick of the even division', () => {
    expect(femRefineTargets(hit('c', 0, 1), 'column', stack, stackIndex)).toEqual(['c']);
    expect(femRefineTargets({ kind: 'face', hex: 0, face: 'XPlus', p: 0, q: 0 }, 'column', stack, stackIndex)).toEqual([]);
  });
});
