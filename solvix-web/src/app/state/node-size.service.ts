import { Injectable } from '@angular/core';

// The size of the dots of the nodes of the cubes - the 8 corners and the 12 midpoints, each its own - as a share of the usual size, in the Ideal and the Real
// World alike. Per session; plain data that the render service reads and puts in its cache key.
export const DEFAULT_NODE_SIZE = 1;
export const MIN_NODE_SIZE = 0.3;
export const MAX_NODE_SIZE = 4;

export type NodeKind = 'corner' | 'mid';

@Injectable({ providedIn: 'root' })
export class NodeSizeService {
  private readonly values = new Map<string, number>();

  get(sessionId: number, kind: NodeKind): number {
    return this.values.get(`${sessionId}:${kind}`) ?? DEFAULT_NODE_SIZE;
  }

  set(sessionId: number, kind: NodeKind, value: number): void {
    if (!Number.isFinite(value)) return;
    this.values.set(`${sessionId}:${kind}`, Math.min(MAX_NODE_SIZE, Math.max(MIN_NODE_SIZE, value)));
  }

  // The settings of a session that is gone.
  forget(sessionId: number): void {
    this.values.delete(`${sessionId}:corner`);
    this.values.delete(`${sessionId}:mid`);
  }
}
