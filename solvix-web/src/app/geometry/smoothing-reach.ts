import { HexFaceName, MeshStateDto } from '../api/mesh-editor-api.service';
import { LOCAL_COORDS } from './mesh-editor-view';

// What smoothing can reach in a mesh: only the corner vertices inside the body move (every face around them is linked
// to a neighbour). A bad element in a cube that has no such vertex is out of its reach.
export interface SmoothingReach {
  // all the corner vertices of the mesh
  readonly corners: number;
  // those inside the body, free to move
  readonly free: number;
  // the bad elements given, and how many of them lie in a cube that has a free vertex
  readonly bad: number;
  readonly badReachable: number;
}

const FACE_SIDE: Record<HexFaceName, readonly [number, number]> = {
  XMinus: [0, -1], XPlus: [0, 1], YMinus: [1, -1], YPlus: [1, 1], ZMinus: [2, -1], ZPlus: [2, 1]
};

export function smoothingReach(state: MeshStateDto, bad: readonly { readonly hex: number }[]): SmoothingReach {
  const corners = new Set<number>();
  const frozen = new Set<number>();
  const byHex = new Map(state.hexes.map(h => [h.id, h]));
  for (const hex of state.hexes) for (let slot = 0; slot < 8; slot++) corners.add(hex.nodeIds[slot]);
  for (const face of state.faces) {
    if (face.status === 'Linked') continue;
    const hex = byHex.get(face.hex);
    if (!hex) continue;
    const [axis, sign] = FACE_SIDE[face.face];
    for (let slot = 0; slot < 8; slot++) if (LOCAL_COORDS[slot][axis] === sign) frozen.add(hex.nodeIds[slot]);
  }
  const reachable = new Set<number>();
  for (const hex of state.hexes) if ([...Array(8).keys()].some(slot => !frozen.has(hex.nodeIds[slot]))) reachable.add(hex.id);
  return {
    corners: corners.size,
    free: [...corners].filter(id => !frozen.has(id)).length,
    bad: bad.length,
    badReachable: bad.filter(e => reachable.has(e.hex)).length
  };
}
