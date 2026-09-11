import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';

// What a "6 сторін" click hands the overlay: the source World's OWN Scene
// (not a clone) - a THREE.Scene can be rendered by any number of
// renderers/cameras at once, so reusing it directly is what makes the
// overlay's 6 panels show exactly what that World shows (model, floor
// grid, lights, imported STL reference, dimension lines, ...) instead of a
// bare re-lit copy of just the model.
export interface SixViewSource {
  readonly scene: THREE.Scene;
  // Everything the 6 cameras should frame themselves on - the session
  // model, plus the imported STL reference when the Ideal World has one
  // shown. Framed as their COMBINED bounding box (not just the first
  // entry, and not each one's own center averaged) so the cameras center
  // on and fit everything at once - degenerates to "center of the model"
  // when this holds just the one object. Fitting to the whole scene
  // instead would frame the 50-unit GridHelper/AxesHelper fixtures every
  // World scene carries, not the actual content.
  readonly framingObjects: readonly THREE.Object3D[];
  // Fixtures of the source World's scene that the 6-view overlay hides
  // while it's open (floor grid, rotate gizmo rings) - kept visible on the
  // source World's own canvas the whole time, since this is the SAME
  // Scene instance; the overlay's render loop flips these off only for
  // its own render() calls and restores them straight after (see
  // SixViewOverlayComponent.animate).
  readonly hiddenDuringView: readonly THREE.Object3D[];
}

// Single shared instance for the whole app - every WorldCanvasComponent's
// "6 сторін" button funnels into this ONE service, so only ONE
// SixViewOverlayComponent (mounted once, at app.component.html) ever
// exists. That keeps the app's total WebGL context count fixed and
// predictable (the 3 WorldCanvasComponent contexts, plus these 6, never
// more) instead of spinning up 6 fresh contexts per World per open.
@Injectable({ providedIn: 'root' })
export class SixViewOverlayService {
  // Non-null means "the overlay should be showing this". Whichever
  // WorldCanvasComponent's button was clicked last wins; there is only
  // ever one overlay, so only one source World at a time.
  readonly active = signal<SixViewSource | null>(null);

  open(source: SixViewSource): void {
    this.active.set(source);
  }

  close(): void {
    this.active.set(null);
  }
}