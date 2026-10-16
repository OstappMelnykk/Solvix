import { SolverMeshDto } from '../api/solver-api.service';
import { femAllMarked, femElementTargets, femFaceTargets, femIndex } from './fem-targets';

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
