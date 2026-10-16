import * as THREE from 'three';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import { SolverMeshDto } from '../api/solver-api.service';
import { LOCAL_COORDS, MeshViewMode, mapHex, nodePosition } from './mesh-editor-view';

// Where the elements of a locally refined mesh stand in the Ideal and in the Real World. The solver's mesh is in real space; an element's key says where its
// eight corners are inside its cube (as exact fractions), so every node of the element can be pushed through the cube's own 20-node map in either world.

// The place inside its cube [-1, 1]^3 of each of the 20 nodes of an element, from the element's key ("cube|scale|x,y,z;..." eight corners, lowest terms); null when the key
// is not a leaf key (an element of an even division).
export function localCoordsOfKey(key: string): number[] | null {
  const parts = key.split('|');
  if (parts.length !== 3) return null;
  const scale = Number(parts[1]);
  const corners = parts[2].split(';').map(c => c.split(',').map(n => (2 * Number(n)) / scale - 1));
  if (!(scale > 0) || corners.length !== 8 || corners.some(c => c.length !== 3 || c.some(v => !Number.isFinite(v)))) return null;
  // the corners come in the order of the lattice (x fastest, then y, then z); the 20 nodes are corners and edge midpoints, all on the straight edges of the element
  const out: number[] = [];
  for (const [a, b, g] of LOCAL_COORDS) {
    const point = [0, 0, 0];
    for (let s = 0; s < 8; s++) {
      const w = ((s & 1 ? 1 + a : 1 - a) * (s & 2 ? 1 + b : 1 - b) * (s & 4 ? 1 + g : 1 - g)) / 8;
      for (let c = 0; c < 3; c++) point[c] += w * corners[s][c];
    }
    out.push(...point);
  }
  return out;
}

// The same mesh with its nodes at their place in the world asked for. An element whose key cannot be read keeps the positions the solver gave it.
export function remapMesh(mesh: SolverMeshDto, state: MeshStateDto, mode: MeshViewMode): SolverMeshDto {
  const nodes = new Map(state.nodes.map(n => [n.id, n]));
  const hexes = new Map(state.hexes.map(h => [h.id, h]));
  const positions = Array.from(mesh.positions);
  const placed = new Set<number>();
  const cubeCache = new Map<number, THREE.Vector3[] | null>();
  const slotsOf = (hexId: number): THREE.Vector3[] | null => {
    if (cubeCache.has(hexId)) return cubeCache.get(hexId)!;
    const hex = hexes.get(hexId);
    const found = hex && hex.nodeIds.every(id => nodes.has(id)) ? hex.nodeIds.map(id => nodePosition(nodes.get(id)!, mode)) : null;
    cubeCache.set(hexId, found);
    return found;
  };
  for (let e = 0; e < mesh.keys.length; e++) {
    const local = localCoordsOfKey(mesh.keys[e]);
    const slots = slotsOf(mesh.hexIds[e]);
    if (!local || !slots) continue;
    for (let k = 0; k < 20; k++) {
      const node = mesh.connectivity[e * 20 + k];
      if (placed.has(node)) continue;
      placed.add(node);
      const at = mapHex(slots, local[3 * k], local[3 * k + 1], local[3 * k + 2]);
      positions[3 * node] = at.x;
      positions[3 * node + 1] = at.y;
      positions[3 * node + 2] = at.z;
    }
  }
  return { ...mesh, positions };
}
