import { HexFaceName, MeshFaceDto, MeshHexDto, MeshNodeDto, MeshStateDto } from '../api/mesh-editor-api.service';

// Shared test fixtures (this file holds no specs of its own): the same 20-node
// layout the backend uses, slot -> local (alpha, beta, gamma).
export const LOCAL_COORDS: readonly (readonly [number, number, number])[] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  [0, -1, -1], [1, 0, -1], [0, 1, -1], [-1, 0, -1],
  [0, -1, 1], [1, 0, 1], [0, 1, 1], [-1, 0, 1],
  [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]
];

export const ALL_FACES: HexFaceName[] = ['XMinus', 'XPlus', 'YMinus', 'YPlus', 'ZMinus', 'ZPlus'];

// A unit cube at lattice cell (i, j, k): nodes get ids baseId .. baseId + 19.
export function cubeNodes(baseId: number, cell: [number, number, number]): MeshNodeDto[] {
  return LOCAL_COORDS.map((c, slot) => ({
    id: baseId + slot,
    x: cell[0] + (c[0] + 1) / 2,
    y: cell[1] + (c[1] + 1) / 2,
    z: cell[2] + (c[2] + 1) / 2,
    idealX: 2 * cell[0] + c[0] + 1,
    idealY: 2 * cell[1] + c[1] + 1,
    idealZ: 2 * cell[2] + c[2] + 1
  }));
}

export function cubeHex(id: number, baseId: number, cell: [number, number, number]): MeshHexDto {
  return { id, cellI: cell[0], cellJ: cell[1], cellK: cell[2], nodeIds: Array.from({ length: 20 }, (_, s) => baseId + s) };
}

export function freeFaces(hex: number): MeshFaceDto[] {
  return ALL_FACES.map(face => ({ hex, face, status: 'Free', otherHex: null, otherFace: null, coincident: null, gap: null }));
}

export function singleCubeState(version = 1): MeshStateDto {
  return {
    version,
    canUndo: true,
    canRedo: false,
    nodes: cubeNodes(0, [0, 0, 0]),
    hexes: [cubeHex(0, 0, [0, 0, 0])],
    links: [],
    faces: freeFaces(0),
    invalidHexes: []
  };
}

// Two cubes side by side, linked across A:XPlus / B:XMinus (their 8 face nodes
// are shared, so 32 nodes in total).
export function linkedPairState(): MeshStateDto {
  const a = cubeNodes(0, [0, 0, 0]);
  const bRaw = cubeNodes(100, [1, 0, 0]);
  const slotsOnA = LOCAL_COORDS.map((c, s) => (c[0] === 1 ? s : -1)).filter(s => s >= 0);
  const sharedPartner = new Map<number, number>();
  for (const s of slotsOnA) {
    const partner = LOCAL_COORDS.findIndex((c, t) => c[0] === -1 && c[1] === LOCAL_COORDS[s][1] && c[2] === LOCAL_COORDS[s][2]);
    sharedPartner.set(100 + partner, s);
  }
  const bNodes = bRaw.filter(n => !sharedPartner.has(n.id));
  const bHex = cubeHex(1, 100, [1, 0, 0]);
  const nodeIds = bHex.nodeIds.map(id => sharedPartner.get(id) ?? id);
  const faces: MeshFaceDto[] = [
    ...freeFaces(0).map(f => (f.face === 'XPlus' ? { ...f, status: 'Linked' as const, otherHex: 1, otherFace: 'XMinus' as const, coincident: true, gap: 0 } : f)),
    ...freeFaces(1).map(f => (f.face === 'XMinus' ? { ...f, status: 'Linked' as const, otherHex: 0, otherFace: 'XPlus' as const, coincident: true, gap: 0 } : f))
  ];
  return {
    version: 2,
    canUndo: true,
    canRedo: false,
    nodes: [...a, ...bNodes],
    hexes: [cubeHex(0, 0, [0, 0, 0]), { ...bHex, nodeIds }],
    links: [{ hexA: 0, faceA: 'XPlus', hexB: 1, faceB: 'XMinus' }],
    faces,
    invalidHexes: []
  };
}
