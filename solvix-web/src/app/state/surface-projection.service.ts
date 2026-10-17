import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { SurfaceSnapper } from '../geometry/surface-snap';

// Where the imported surface (the STL reference) of the Real World can be asked for the nearest point to a place. The surface lives in the Real World's canvas (it is
// what the canvas draws, turned the way the user turned it); the canvas hands out its snapper here, and takes it back when it goes, so the panel can drop points on
// the surface without knowing the canvas.
@Injectable({ providedIn: 'root' })
export class SurfaceProjectionService {
  private provider: (() => SurfaceSnapper | null) | null = null;

  register(provider: () => SurfaceSnapper | null): void {
    this.provider = provider;
  }

  unregister(provider: () => SurfaceSnapper | null): void {
    if (this.provider === provider) this.provider = null;
  }

  // Whether there is a surface to drop on.
  hasSurface(): boolean {
    const snapper = this.provider?.();
    return !!snapper && !snapper.isEmpty;
  }

  // The nearest point of the surface to each place - the foot of the perpendicular dropped on it - or null for every place when there is no surface.
  nearestPoints(places: readonly THREE.Vector3[]): (THREE.Vector3 | null)[] {
    const snapper = this.provider?.();
    if (!snapper || snapper.isEmpty) return places.map(() => null);
    return places.map(place => snapper.closest(place)?.point.clone() ?? null);
  }
}
