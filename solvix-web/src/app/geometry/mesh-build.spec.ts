import { buildCommandFor } from './mesh-build';
import { MeshPick } from './mesh-editor-view';

describe('buildCommandFor', () => {
  const face: MeshPick = { kind: 'face', hex: 3, face: 'XPlus' };
  const node: MeshPick = { kind: 'node', nodeId: 9 };
  const ground = { i: 2, j: 0 as const, k: -1 };

  it('removes the cube under a left click', () => {
    expect(buildCommandFor({ action: 'remove', pick: face, ground: null }, 5)).toEqual({ kind: 'removeHex', hex: 3 });
  });

  it('adds a cube on the face under a right click', () => {
    expect(buildCommandFor({ action: 'add', pick: face, ground: null }, 5)).toEqual({ kind: 'addOnFace', hex: 3, face: 'XPlus' });
  });

  it('puts the first cube in the ground cell under a right click when there are no cubes', () => {
    expect(buildCommandFor({ action: 'add', pick: null, ground }, 0)).toEqual({ kind: 'addFirst', cell: ground });
  });

  it('does nothing for the ground once there are cubes, for a node, or for empty space', () => {
    expect(buildCommandFor({ action: 'add', pick: null, ground }, 2)).toBeNull();
    expect(buildCommandFor({ action: 'add', pick: node, ground: null }, 2)).toBeNull();
    expect(buildCommandFor({ action: 'remove', pick: node, ground: null }, 2)).toBeNull();
    expect(buildCommandFor({ action: 'remove', pick: null, ground: null }, 2)).toBeNull();
    expect(buildCommandFor({ action: 'add', pick: null, ground: null }, 0)).toBeNull();
  });

  it('lets a face win over the ground', () => {
    expect(buildCommandFor({ action: 'add', pick: face, ground }, 0)).toEqual({ kind: 'addOnFace', hex: 3, face: 'XPlus' });
  });
});
