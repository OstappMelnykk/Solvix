import { Injectable } from '@angular/core';
import { IDEAL_WORLD_INDEX, QUALITY_WORLD_INDEX, REAL_WORLD_INDEX } from '../config/app-settings';

// What the faces of the Ideal and Real Worlds are drawn with by default: a faint tint, so the nodes and the lines show.
export const DEFAULT_FACE_OPACITY = 0.22;

// How opaque the geometry of a World is, set per session and per World (the Solver World keeps its own, in its view
// settings). In the Ideal and Real Worlds it is the opacity of a cube's faces (the other face states scale with it);
// in the Quality World it is the opacity of the whole body, so the bad elements inside show through. Plain data, read
// by the render services, which put it in their cache keys.
@Injectable({ providedIn: 'root' })
export class GeometryOpacityService {
  private readonly values = new Map<string, number>();
  private revisions = new Map<number, number>();

  static minimum(worldIndex: number): number {
    return worldIndex === QUALITY_WORLD_INDEX ? 0.05 : 0.02;
  }

  static initial(worldIndex: number): number {
    return worldIndex === IDEAL_WORLD_INDEX || worldIndex === REAL_WORLD_INDEX ? DEFAULT_FACE_OPACITY : 1;
  }

  get(sessionId: number, worldIndex: number): number {
    return this.values.get(`${sessionId}:${worldIndex}`) ?? GeometryOpacityService.initial(worldIndex);
  }

  set(sessionId: number, worldIndex: number, value: number): void {
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(1, Math.max(GeometryOpacityService.minimum(worldIndex), value));
    this.values.set(`${sessionId}:${worldIndex}`, clamped);
  }

  // The settings of a session that is gone.
  forget(sessionId: number): void {
    for (const key of [...this.values.keys()]) if (key.startsWith(`${sessionId}:`)) this.values.delete(key);
  }
}
