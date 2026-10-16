import { Injectable } from '@angular/core';

// The size of the 20 nodes of the cubes (corners and midpoints) in the Real World, as a share of the usual one. Per session; plain data
// that the render service reads and puts in its cache key.
export const DEFAULT_NODE_SIZE = 1;
export const MIN_NODE_SIZE = 0.3;
export const MAX_NODE_SIZE = 4;

@Injectable({ providedIn: 'root' })
export class NodeSizeService {
  private readonly values = new Map<number, number>();

  get(sessionId: number): number {
    return this.values.get(sessionId) ?? DEFAULT_NODE_SIZE;
  }

  set(sessionId: number, value: number): void {
    if (!Number.isFinite(value)) return;
    this.values.set(sessionId, Math.min(MAX_NODE_SIZE, Math.max(MIN_NODE_SIZE, value)));
  }

  // The settings of a session that is gone.
  forget(sessionId: number): void {
    this.values.delete(sessionId);
  }
}
