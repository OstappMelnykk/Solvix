import * as THREE from 'three';
import { MeshDto } from './api';

// A chord is a chain of cells joined through opposite edges. Along an axis it runs through the edges across that axis:
// bottom (slots 0-1) and top (2-3) for Y, left (3-0) and right (1-2) for X. Cells are numbered 0, 1, 2, ... from the start of the chain;
// the numbers (0,1), (2,3), ... are the pairs, and the edge a pair shares is its seam.
export interface ChordInfo { chord: number; position: number; }
export interface Chords { info: Map<number, ChordInfo>; seams: [number, number][]; count: number; }

export function chordsOf(mesh: MeshDto, axis: number): Chords {
  const edgeNodes = (cell: { nodes: number[] }, e: number): [number, number] => [cell.nodes[e], cell.nodes[(e + 1) % 4]];
  const key = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const owners = new Map<string, [number, number][]>();           // edge -> (cell index, edge slot)
  mesh.cells.forEach((cell, i) => {
    for (let e = 0; e < 4; e++) {
      const [a, b] = edgeNodes(cell, e);
      const k = key(a, b);
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k)!.push([i, e]);
    }
  });
  const entry = axis === 1 ? 0 : 3;                                // the edge a chord is followed back through from its first cell
  // the cell on the other side of an edge, and the edge of that cell the chord leaves through
  const across = (i: number, e: number): [number, number] | null => {
    const [a, b] = edgeNodes(mesh.cells[i], e);
    const other = owners.get(key(a, b))!.find(([c]) => c !== i);
    return other ? [other[0], (other[1] + 2) % 4] : null;
  };

  const info = new Map<number, ChordInfo>();
  const seams: [number, number][] = [];
  const visited = new Set<string>();                              // (cell, pair of edges the chord crosses it through)
  const natural = axis === 1 ? 0 : 1;                             // the pair of edges of a cell that lie across the axis
  let count = 0;
  for (let start = 0; start < mesh.cells.length; start++) {
    if (visited.has(`${start}:${natural}`)) continue;
    // walk back to the beginning of the chain (all the way round, when it is closed)
    let first = start, back = entry;
    for (let guard = 0; guard <= mesh.cells.length; guard++) {
      const step = across(first, back);
      if (!step || step[0] === start) break;
      [first, back] = step;
    }
    let cell = first, leave = (back + 2) % 4, position = 0;
    const chain: [number, number][] = [];
    while (!visited.has(`${cell}:${leave % 2}`)) {
      visited.add(`${cell}:${leave % 2}`);
      // a chord can also run through a cell sideways (a corner piece of a template); that cell keeps the chord of its own pair of edges
      if (leave % 2 === natural || !info.has(cell)) info.set(cell, { chord: count, position });
      chain.push([cell, leave]);
      const next = across(cell, leave);
      if (!next) break;
      [cell, leave] = next;
      position++;
    }
    for (let k = 0; k + 1 < chain.length; k += 2) {
      const [a, e1] = [chain[k][0], chain[k][1]];
      seams.push(edgeNodes(mesh.cells[a], e1));
    }
    count++;
  }
  return { info, seams, count };
}

const labels = new Map<number, THREE.CanvasTexture>();
export function label(n: number): THREE.CanvasTexture {
  let texture = labels.get(n);
  if (!texture) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.font = 'bold 40px system-ui';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = '#fff';
    g.strokeText(String(n), 32, 34);
    g.fillStyle = '#111';
    g.fillText(String(n), 32, 34);
    texture = new THREE.CanvasTexture(c);
    labels.set(n, texture);
  }
  return texture;
}
