import { Injectable } from '@angular/core';
import { IDEAL_WORLD_INDEX, QUALITY_WORLD_INDEX, REAL_WORLD_INDEX } from '../config/app-settings';

// How opaque the body is drawn by default: solid (100 %); the slider makes it translucent to see the inner lines and nodes, the nearer ones stronger and the farther dimmer.
export const DEFAULT_BODY_OPACITY = 1;

// The lowest opacity of the body.
export const MIN_BODY_OPACITY = 0.05;

// How opaque the body is, per session. It is ONE value for the Ideal, the Real and the Quality World (a slider in any of them moves it for all three, so
// the body looks the same wherever one looks at it); 100% is a solid body, less shows the inside. The Solver World keeps its own opacity in its view
// settings. Plain data, read by the render services, which put it in their cache keys.
@Injectable({ providedIn: 'root' })
export class GeometryOpacityService {
  private readonly values = new Map<number, number>();

  static minimum(_worldIndex: number): number {
    return MIN_BODY_OPACITY;
  }

  static initial(worldIndex: number): number {
    return GeometryOpacityService.sharesTheBody(worldIndex) ? DEFAULT_BODY_OPACITY : 1;
  }

  private static sharesTheBody(worldIndex: number): boolean {
    return worldIndex === IDEAL_WORLD_INDEX || worldIndex === REAL_WORLD_INDEX || worldIndex === QUALITY_WORLD_INDEX;
  }

  get(sessionId: number, worldIndex: number): number {
    if (!GeometryOpacityService.sharesTheBody(worldIndex)) return 1;
    return this.values.get(sessionId) ?? DEFAULT_BODY_OPACITY;
  }

  set(sessionId: number, worldIndex: number, value: number): void {
    if (!Number.isFinite(value) || !GeometryOpacityService.sharesTheBody(worldIndex)) return;
    this.values.set(sessionId, Math.min(1, Math.max(MIN_BODY_OPACITY, value)));
  }

  // The settings of a session that is gone.
  forget(sessionId: number): void {
    this.values.delete(sessionId);
  }
}
