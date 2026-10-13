import { MeshFaceDto, MeshHexDto, MeshNodeDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { smoothingReach } from './smoothing-reach';
import { ALL_FACES, linkedPairState, singleCubeState } from './mesh-state.fixture.spec';

describe('smoothingReach', () => {
  it('finds no free vertex in a single cube or a pair: every vertex is on the surface', () => {
    expect(smoothingReach(singleCubeState(), [{ hex: 0 }])).toEqual({ corners: 8, free: 0, bad: 1, badReachable: 0 });
    const pair = smoothingReach(linkedPairState(), [{ hex: 0 }, { hex: 1 }]);
    expect(pair.free).toBe(0);
    expect(pair.badReachable).toBe(0);
  });

  it('counts a vertex as free only when every face around it is linked', () => {
    // 2 x 2 x 2 cubes: the one vertex in the middle is free, and every cube touches it
    const state = eightCubes();
    const reach = smoothingReach(state, state.hexes.map(h => ({ hex: h.id })));

    expect(reach.free).toBe(1);
    expect(reach.corners).toBe(27);
    expect(reach.badReachable).toBe(8);
  });
});

// 2 x 2 x 2 cubes sharing nodes by lattice position (corners only matter here)
function eightCubes(): MeshStateDto {
  const corner = new Map<string, number>();
  const nodes: MeshNodeDto[] = [];
  const id = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    if (!corner.has(key)) {
      corner.set(key, nodes.length);
      nodes.push({ id: nodes.length, x, y, z, idealX: 2 * x, idealY: 2 * y, idealZ: 2 * z });
    }
    return corner.get(key)!;
  };
  const hexes: MeshHexDto[] = [];
  const cells: [number, number, number][] = [];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) cells.push([i, j, k]);
  const local = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  cells.forEach(([i, j, k], index) => {
    const nodeIds = local.map(c => id(i + (c[0] + 1) / 2, j + (c[1] + 1) / 2, k + (c[2] + 1) / 2));
    while (nodeIds.length < 20) nodeIds.push(id(i + 0.5 + nodeIds.length, j, k + 10));     // the midpoints are not looked at
    hexes.push({ id: index, cellI: i, cellJ: j, cellK: k, nodeIds });
  });
  const faces: MeshFaceDto[] = [];
  for (const hex of hexes) {
    for (const face of ALL_FACES) {
      const axis = face.charCodeAt(0) - 88, sign = face.endsWith('Plus') ? 1 : -1;
      const cell = [hex.cellI, hex.cellJ, hex.cellK];
      const next = [...cell];
      next[axis] += sign;
      const other = hexes.find(h => h.cellI === next[0] && h.cellJ === next[1] && h.cellK === next[2]);
      faces.push({ hex: hex.id, face, status: other ? 'Linked' : 'Free', otherHex: other?.id ?? null, otherFace: null, coincident: null, gap: null });
    }
  }
  return { version: 1, canUndo: false, canRedo: false, hexes, nodes, links: [], faces, invalidHexes: [] } as unknown as MeshStateDto;
}
