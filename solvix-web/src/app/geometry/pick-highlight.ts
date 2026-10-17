import * as THREE from 'three';
import { MeshStateDto } from '../api/mesh-editor-api.service';
import { wideLines } from './fem-mesh-view';
import { MeshPick, MeshViewMode, edgeCurves, faceAxis, faceSign, mapHex, nodePosition } from './mesh-editor-view';

// What a click on the body would pick, shown while the pointer is only over it (the Ideal and Real Worlds): a face is covered with a red coat and outlined, an edge is
// drawn red and thick. Drawn over everything, so it is seen whether the face is in front or inside the body. A node needs none: it is a dot already.

const HOVER_COLOR = 0xff4d4d;
const RESOLUTION = 6;

export function buildPickHighlight(state: MeshStateDto, mode: MeshViewMode, pick: MeshPick): THREE.Group | null {
  if (pick.kind === 'node') return null;
  const group = new THREE.Group();
  const color = new THREE.Color(HOVER_COLOR);
  const colors = (count: number) => Array.from({ length: count }, () => [color.r, color.g, color.b]).flat();
  const hex = state.hexes.find(h => h.id === pick.hex);
  const nodes = new Map(state.nodes.map(n => [n.id, n]));
  if (!hex || !hex.nodeIds.every(id => nodes.has(id))) return null;

  if (pick.kind === 'edge') {
    const curve = edgeCurves({ ...state, hexes: [hex] }, mode).find(c => c.edge === pick.edge);
    if (!curve) return null;
    const lines: number[] = [];
    for (let i = 0; i + 1 < curve.points.length; i++) lines.push(...curve.points[i].toArray(), ...curve.points[i + 1].toArray());
    group.add(wideLines(lines, colors(lines.length / 3), 3, { opacity: 1, depthTest: false }));
  } else {
    const slots = hex.nodeIds.map(id => nodePosition(nodes.get(id)!, mode));
    const axis = faceAxis(pick.face);
    const [u, v] = [0, 1, 2].filter(d => d !== axis);
    const sign = faceSign(pick.face);
    const at = (iu: number, iv: number) => {
      const local = [0, 0, 0];
      local[axis] = sign;
      local[u] = -1 + (2 * iu) / RESOLUTION;
      local[v] = -1 + (2 * iv) / RESOLUTION;
      return mapHex(slots, local[0], local[1], local[2]);
    };
    const positions: number[] = [];
    const indices: number[] = [];
    for (let iv = 0; iv <= RESOLUTION; iv++) for (let iu = 0; iu <= RESOLUTION; iu++) positions.push(...at(iu, iv).toArray());
    const stride = RESOLUTION + 1;
    for (let iv = 0; iv < RESOLUTION; iv++)
      for (let iu = 0; iu < RESOLUTION; iu++) {
        const a = iv * stride + iu;
        indices.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: HOVER_COLOR, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false, side: THREE.DoubleSide })));
    // the outline of the face: its 4 sides as curves
    const rim: number[] = [];
    const side = (from: [number, number], to: [number, number]) => {
      let last = at(from[0] * RESOLUTION, from[1] * RESOLUTION);
      for (let s = 1; s <= RESOLUTION; s++) {
        const next = at((from[0] + (to[0] - from[0]) * s / RESOLUTION) * RESOLUTION, (from[1] + (to[1] - from[1]) * s / RESOLUTION) * RESOLUTION);
        rim.push(...last.toArray(), ...next.toArray());
        last = next;
      }
    };
    side([0, 0], [1, 0]);
    side([1, 0], [1, 1]);
    side([1, 1], [0, 1]);
    side([0, 1], [0, 0]);
    group.add(wideLines(rim, colors(rim.length / 3), 2, { opacity: 1, depthTest: false }));
  }
  group.renderOrder = 8;
  group.traverse(o => (o.frustumCulled = false));
  return group;
}
