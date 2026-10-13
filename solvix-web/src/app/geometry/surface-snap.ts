import * as THREE from 'three';

// The nearest point on an imported surface (the STL reference), for sticking a cube's vertex to it: the triangles of
// every mesh under `root`, in world space, in a uniform grid so that a query looks only at the triangles near the point.

export interface SurfaceHit {
  readonly point: THREE.Vector3;
  readonly distance: number;
}

const MAX_CELLS_PER_AXIS = 64;
const TRIANGLES_PER_CELL = 2;

export class SurfaceSnapper {
  // a, b, c of every triangle, flat
  private readonly triangles: Float32Array;
  private readonly box = new THREE.Box3();
  private readonly cells: [number, number, number];
  private readonly cellSize: THREE.Vector3;
  private readonly grid = new Map<number, number[]>();
  readonly triangleCount: number;

  constructor(root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    const flat: number[] = [];
    const a = new THREE.Vector3();
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const position = object.geometry.getAttribute('position');
      if (!position) return;
      const index = object.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let i = 0; i < count; i++) {
        const v = index ? index.getX(i) : i;
        a.fromBufferAttribute(position, v).applyMatrix4(object.matrixWorld);
        flat.push(a.x, a.y, a.z);
      }
    });
    this.triangles = Float32Array.from(flat);
    this.triangleCount = Math.floor(this.triangles.length / 9);

    for (let i = 0; i < this.triangleCount * 3; i++) this.box.expandByPoint(a.set(this.triangles[3 * i], this.triangles[3 * i + 1], this.triangles[3 * i + 2]));
    const size = this.box.isEmpty() ? new THREE.Vector3() : this.box.getSize(new THREE.Vector3());
    const perAxis = Math.min(MAX_CELLS_PER_AXIS, Math.max(1, Math.ceil(Math.cbrt(this.triangleCount / TRIANGLES_PER_CELL))));
    this.cells = [perAxis, perAxis, perAxis];
    this.cellSize = new THREE.Vector3(Math.max(size.x / perAxis, 1e-9), Math.max(size.y / perAxis, 1e-9), Math.max(size.z / perAxis, 1e-9));
    for (let t = 0; t < this.triangleCount; t++) this.insert(t);
  }

  // The size of the surface (its box diagonal): limits are given as a share of it.
  get diagonal(): number {
    return this.box.isEmpty() ? 0 : this.box.min.distanceTo(this.box.max);
  }

  get isEmpty(): boolean {
    return this.triangleCount === 0;
  }

  // The closest point of the surface to `p`, or null when the surface is further than `maxDistance` (or empty).
  closest(p: THREE.Vector3, maxDistance = Infinity): SurfaceHit | null {
    if (this.isEmpty) return null;
    const start = this.cellOf(p);
    const best = new THREE.Vector3();
    const candidate = new THREE.Vector3();
    let bestDistance = Infinity;
    const longest = Math.max(this.cells[0], this.cells[1], this.cells[2]);
    const smallest = Math.min(this.cellSize.x, this.cellSize.y, this.cellSize.z);
    const seen = new Set<number>();
    for (let ring = 0; ring <= longest; ring++) {
      // every cell at Chebyshev distance `ring` from the start cell
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dz = -ring; dz <= ring; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
            const list = this.grid.get(this.key(start[0] + dx, start[1] + dy, start[2] + dz));
            if (!list) continue;
            for (const t of list) {
              if (seen.has(t)) continue;
              seen.add(t);
              const d = this.distanceToTriangle(p, t, candidate);
              if (d < bestDistance) {
                bestDistance = d;
                best.copy(candidate);
              }
            }
          }
        }
      }
      // nothing in the rings still to come can be closer than ring * the smallest cell
      if (bestDistance <= ring * smallest) break;
      if (ring * smallest > maxDistance && bestDistance === Infinity) return null;
    }
    return bestDistance <= maxDistance ? { point: best, distance: bestDistance } : null;
  }

  // ---- the grid ----

  private cellOf(p: THREE.Vector3): [number, number, number] {
    const clamp = (v: number, axis: number) => Math.min(this.cells[axis] - 1, Math.max(0, Math.floor(v)));
    return [clamp((p.x - this.box.min.x) / this.cellSize.x, 0), clamp((p.y - this.box.min.y) / this.cellSize.y, 1), clamp((p.z - this.box.min.z) / this.cellSize.z, 2)];
  }

  private key(x: number, y: number, z: number): number {
    return x < 0 || y < 0 || z < 0 || x >= this.cells[0] || y >= this.cells[1] || z >= this.cells[2] ? -1 : (x * this.cells[1] + y) * this.cells[2] + z;
  }

  private insert(t: number): void {
    const o = 9 * t;
    const low = new THREE.Vector3(Infinity, Infinity, Infinity);
    const high = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let k = 0; k < 3; k++) {
      low.min(new THREE.Vector3(this.triangles[o + 3 * k], this.triangles[o + 3 * k + 1], this.triangles[o + 3 * k + 2]));
      high.max(new THREE.Vector3(this.triangles[o + 3 * k], this.triangles[o + 3 * k + 1], this.triangles[o + 3 * k + 2]));
    }
    const from = this.cellOf(low);
    const to = this.cellOf(high);
    for (let x = from[0]; x <= to[0]; x++)
      for (let y = from[1]; y <= to[1]; y++)
        for (let z = from[2]; z <= to[2]; z++) {
          const key = this.key(x, y, z);
          const list = this.grid.get(key);
          if (list) list.push(t);
          else this.grid.set(key, [t]);
        }
  }

  // ---- the closest point on a triangle (Ericson, Real-Time Collision Detection) ----

  private distanceToTriangle(p: THREE.Vector3, t: number, out: THREE.Vector3): number {
    const o = 9 * t;
    const T = this.triangles;
    const ax = T[o], ay = T[o + 1], az = T[o + 2];
    const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
    const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = p.x - ax, apy = p.y - ay, apz = p.z - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return this.finish(p, out, ax, ay, az);
    const bpx = p.x - bx, bpy = p.y - by, bpz = p.z - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return this.finish(p, out, bx, by, bz);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      return this.finish(p, out, ax + v * abx, ay + v * aby, az + v * abz);
    }
    const cpx = p.x - cx, cpy = p.y - cy, cpz = p.z - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return this.finish(p, out, cx, cy, cz);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      return this.finish(p, out, ax + w * acx, ay + w * acy, az + w * acz);
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      return this.finish(p, out, bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz));
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return this.finish(p, out, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
  }

  private finish(p: THREE.Vector3, out: THREE.Vector3, x: number, y: number, z: number): number {
    out.set(x, y, z);
    return Math.hypot(p.x - x, p.y - y, p.z - z);
  }
}

// A node a user drags: where it ends up with regard to the surface, and whether it sticks or lets go.
//  - released (Alt held): the node is free; if it was stuck, it lets go;
//  - stuck: kept on the surface - the nearest point of it to where the pointer drags the node;
//  - free and within `share` of the surface's size from it: sticks, at the nearest point;
//  - otherwise: unchanged.
export interface StickResult {
  readonly point: THREE.Vector3 | null;
  readonly change: 'attach' | 'detach' | null;
}

export function stick(snapper: SurfaceSnapper, position: THREE.Vector3, attached: boolean, released: boolean, share: number): StickResult {
  if (snapper.isEmpty) return { point: null, change: null };
  if (released) return { point: null, change: attached ? 'detach' : null };
  const hit = snapper.closest(position, attached ? Infinity : share * snapper.diagonal);
  if (!hit) return { point: null, change: null };
  return { point: hit.point, change: attached ? null : 'attach' };
}
