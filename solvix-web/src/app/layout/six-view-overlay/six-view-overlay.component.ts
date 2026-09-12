import { AfterViewInit, Component, ElementRef, OnDestroy, QueryList, ViewChildren, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SixViewOverlayService, SixViewSource } from '../../state/six-view-overlay.service';
import { WeightedOitRenderer } from '../../rendering/weighted-oit';
import { VoxelizationService } from '../../state/voxelization.service';
import { ImportedReferenceDisplayService } from '../../state/imported-reference-display.service';

interface ViewDirection {
  readonly label: string;
  readonly eye: THREE.Vector3;
  readonly up: THREE.Vector3;
}

// Order MUST match the 6 <canvas> elements' document order in
// six-view-overlay.component.html - ViewChildren resolves them in that
// order, and index i here is rendered into canvasRefs[i].
const VIEW_DIRECTIONS: ViewDirection[] = [
  { label: '+X', eye: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  { label: '-X', eye: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  // Looking straight down/up, world Y can't serve as the up vector (it's
  // parallel to the view direction) - Z stands in instead.
  { label: '+Y', eye: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) },
  { label: '-Y', eye: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
  { label: '+Z', eye: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
  { label: '-Z', eye: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) }
];

// One shared instance for the whole app (mounted once at app.component.html)
// - see SixViewOverlayService's doc comment for why. Holds 6 orthographic
// WebGLRenderers, one per axis direction, all rendering the SAME live Scene
// the source WorldCanvasComponent itself renders (SixViewOverlayService.
// SixViewSource) - not a clone - so every panel shows exactly what that
// World shows (model, lights, imported STL reference, ...), just from 6
// undistorted, CAD-style orthographic angles instead of one perspective/
// orthographic angle the user picks by hand. Each panel is independently
// pannable/zoomable (OrbitControls, rotation disabled) but never rotates -
// rotating would break the whole point of a fixed-axis view.
@Component({
  selector: 'app-six-view-overlay',
  standalone: true,
  imports: [NgIf],
  // Host-bound (not passed in by app.component.html) - this component reads
  // SixViewOverlayService directly, so any WorldCanvasComponent's "6 сторін"
  // button can drive it without app.component needing to plumb the service
  // through as an @Input.
  host: { '[hidden]': 'isHidden()' },
  templateUrl: './six-view-overlay.component.html',
  styleUrl: './six-view-overlay.component.scss'
})
export class SixViewOverlayComponent implements AfterViewInit, OnDestroy {
  @ViewChildren('canvas') private canvasRefs!: QueryList<ElementRef<HTMLCanvasElement>>;

  private readonly overlay = inject(SixViewOverlayService);
  private readonly voxelization = inject(VoxelizationService);
  private readonly referenceDisplay = inject(ImportedReferenceDisplayService);

  private renderers: THREE.WebGLRenderer[] = [];
  // Same stable STL+voxel transparency fix as WorldCanvasComponent's own
  // main view (rendering/weighted-oit.ts) - one instance per panel, since
  // each panel is its own WebGLRenderer/WebGL context.
  private oitRenderers: WeightedOitRenderer[] = [];
  private cameras: THREE.OrthographicCamera[] = [];
  // Pan (screen-space, rotation disabled) + zoom per panel - independent
  // per camera, so dragging/scrolling one panel never affects the other 5.
  private controls: OrbitControls[] = [];
  // Orthographic frustum half-height per camera - world units, independent
  // of each panel's aspect ratio (which the render loop applies on top of
  // this) and of the user's own zoom (OrbitControls drives camera.zoom
  // separately - see rebuildFraming). Parallel array to `cameras`, indexed
  // the same way.
  private cameraHalfHeights: number[] = [];
  private readonly lastPanelSizes: { width: number; height: number }[] = VIEW_DIRECTIONS.map(() => ({ width: 0, height: 0 }));
  // The last-computed combined bounding sphere (rebuildFraming) - shared by
  // all 6 cameras, only their look direction differs. Kept around so a
  // single panel's "recenter" button (applyFraming) can reset just THAT
  // camera back to it without recomputing bounds or touching the other 5.
  private readonly framingCenter = new THREE.Vector3();
  private framingRadius = 1;
  // The SixViewSource last used to aim the 6 cameras - reset to null
  // whenever the overlay closes (see animate below), so reopening always
  // re-frames (and resets pan/zoom) from the model's CURRENT bounds, even
  // against the same World/model reference as before (e.g. edited via
  // voxel build while the overlay was closed).
  private lastSource: SixViewSource | null = null;
  private frameId = 0;
  private viewReady = false;
  // Without preventDefault() here, a lost WebGL context on any of these 6
  // canvases is PERMANENT - the browser only ever attempts to restore a
  // context whose loss event was explicitly prevented. Contexts can be
  // lost for reasons entirely outside this app's own control (GPU memory
  // pressure, a backgrounded browser tab, the OS reclaiming resources), not
  // just from how many this app itself has open at once - every WebGL
  // canvas needs this, matching WorldCanvasComponent's own long-standing
  // handling, which these 6 canvases never had.
  private readonly onContextLost = (event: Event) => event.preventDefault();

  // Deliberately does NOT create the 6 WebGLRenderers here - this used to,
  // always-mounted since app boot alongside the 3 WorldCanvasComponent
  // contexts, ZonePaintingComponent's 4, and SurfaceZonePaintingComponent's
  // 4 - even with those 2 painting tools ALSO made lazy (create-on-open,
  // free-on-close, since they're never both open at once), a real report
  // still showed the Ideal World canvas going blank right after finishing
  // the STL painting flow: THREE.WebGLRenderer.dispose() asks the browser
  // to release a context but doesn't guarantee it happens immediately, so
  // a rapid open/close cycle can transiently exceed the browser's per-page
  // WebGL context limit (commonly 16 in Chrome) even when the STEADY-STATE
  // count looks safe on paper. Making this the 3rd tool with a lazy
  // create/teardown lifecycle drops the worst case from 3 + 6 + 4 = 13 down
  // to 3 + 4 = 7 (this overlay and the 2 painting tools are mutually
  // exclusive with each other and with each other, so at most one set of 4
  // extra ever exists at a time) - a much bigger margin against exactly
  // this kind of disposal-timing race.
  ngAfterViewInit(): void {
    this.viewReady = true;
    this.animate();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.teardownRenderers();
  }

  private ensureRenderersReady(): boolean {
    if (this.renderers.length > 0) {
      return true;
    }
    const canvases = this.canvasRefs.toArray().map(ref => ref.nativeElement);
    // Same "wait for real dimensions" reasoning as the 2 painting tools'
    // own ensureRenderersReady - [hidden] flips the instant overlay.active()
    // becomes non-null, in the SAME tick this checks it, before Angular's
    // own change detection has necessarily caught up.
    if (canvases.some(canvas => canvas.clientWidth === 0 || canvas.clientHeight === 0)) {
      return false;
    }
    // logarithmicDepthBuffer matters more here than on the main World
    // canvases: a large loaded model can push the near:far ratio (see
    // rebuildFraming) well past what a plain depth buffer can resolve,
    // which reads as the model's far side being incorrectly z-culled -
    // "the camera doesn't see far enough" - rather than an actual near/far
    // clipping-plane miss. Same fix WorldCanvasComponent's own renderer
    // already uses, for the same reason.
    canvases.forEach(canvas => canvas.addEventListener('webglcontextlost', this.onContextLost, false));
    this.renderers = canvases.map(canvas => new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true }));
    this.oitRenderers = this.renderers.map(renderer => new WeightedOitRenderer(renderer));
    this.cameras = VIEW_DIRECTIONS.map(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000));
    this.cameraHalfHeights = VIEW_DIRECTIONS.map(() => 1);
    this.controls = this.cameras.map((camera, i) => {
      const controls = new OrbitControls(camera, canvases[i]);
      controls.enableRotate = false;
      controls.screenSpacePanning = true;
      controls.enableDamping = false;
      // Left-drag pans (not the default rotate, which enableRotate above
      // already blocks anyway) - the "move like in 2D, up/down/left/right"
      // behavior the user asked for shouldn't need a modifier key/middle
      // button to reach.
      controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      return controls;
    });
    this.lastPanelSizes.forEach(size => {
      size.width = 0;
      size.height = 0;
    });
    return true;
  }

  private teardownRenderers(): void {
    if (this.renderers.length === 0) {
      return;
    }
    this.canvasRefs.forEach(ref => ref.nativeElement.removeEventListener('webglcontextlost', this.onContextLost));
    this.controls.forEach(controls => controls.dispose());
    this.oitRenderers.forEach(renderer => renderer.dispose());
    this.renderers.forEach(renderer => renderer.dispose());
    this.renderers = [];
    this.oitRenderers = [];
    this.cameras = [];
    this.controls = [];
  }

  close(): void {
    this.overlay.close();
  }

  isHidden(): boolean {
    return this.overlay.active() === null;
  }

  // Gates the voxel-fill/STL-reference opacity sliders (six-view-overlay.
  // component.html) - meaningless outside the Ideal World (see SixViewSource's
  // own doc comment), same as settings-panel.component.html's
  // *ngIf="isIdealWorld()" for the identical pair of sliders there.
  showModelOpacityControls(): boolean {
    return this.overlay.active()?.isIdealWorld === true;
  }

  // Direct opacity passthrough (no [0,1]<->percent inversion) - matches
  // imported-reference-controls.component.ts's own getVoxelOpacityPercent/
  // onVoxelOpacityChange and getReferenceOpacityPercent/onReferenceOpacityChange,
  // so the same slider position means the same thing here as it does on the
  // main settings panel.
  voxelOpacityPercent(): number {
    const sessionId = this.overlay.active()?.sessionId;
    return sessionId === undefined ? 0 : Math.round(this.voxelization.getOpacity(sessionId) * 100);
  }

  onVoxelOpacityChange(event: Event): void {
    const sessionId = this.overlay.active()?.sessionId;
    if (sessionId === undefined) {
      return;
    }
    const percent = Number((event.target as HTMLInputElement).value);
    this.voxelization.setOpacity(sessionId, percent / 100);
  }

  referenceOpacityPercent(): number {
    const sessionId = this.overlay.active()?.sessionId;
    return sessionId === undefined ? 50 : Math.round(this.referenceDisplay.getStyle(sessionId).opacity * 100);
  }

  onReferenceOpacityChange(event: Event): void {
    const sessionId = this.overlay.active()?.sessionId;
    if (sessionId === undefined) {
      return;
    }
    const percent = Number((event.target as HTMLInputElement).value);
    this.referenceDisplay.setOpacity(sessionId, percent / 100);
  }

  // Recomputes the COMBINED bounding sphere of every object in
  // `framingObjects` (the model, plus the imported STL reference when
  // there is one) - not the world origin/coordinate axes, and not each
  // object's own center averaged, but the center of their UNION - so a
  // single model is centered on itself, and a model shown alongside an STL
  // reference is centered on both together, each fully in frame along its
  // own 2 relevant axes for that view. Then applies it to all 6 cameras
  // (applyFraming) - resetting each one's pan/zoom (OrbitControls) too.
  private rebuildFraming(framingObjects: readonly THREE.Object3D[]): void {
    const box = new THREE.Box3();
    framingObjects.forEach(object => box.expandByObject(object));
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
    this.framingCenter.copy(sphere.center);
    this.framingRadius = Math.max(sphere.radius, 0.01);
    this.cameras.forEach((_, i) => this.applyFraming(i));
  }

  // Resets ONE camera (and its OrbitControls) to the last-computed framing
  // (framingCenter/framingRadius) - shared logic between rebuildFraming
  // (all 6, on open/model change) and recenter() (just the one panel the
  // user clicked "recenter" on).
  private applyFraming(i: number): void {
    const camera = this.cameras[i];
    const direction = VIEW_DIRECTIONS[i];
    const radius = this.framingRadius;
    // Padded past the model's own extent so nothing clips the near/far
    // planes regardless of which axis is looking at it, or how far the
    // user zooms/pans afterward.
    const distance = radius * 3;
    const halfHeight = radius * 1.15;

    camera.position.copy(this.framingCenter).addScaledVector(direction.eye, distance);
    camera.up.copy(direction.up);
    camera.zoom = 1;
    camera.lookAt(this.framingCenter);
    camera.near = 0.1;
    camera.far = distance + radius * 10;
    this.cameraHalfHeights[i] = halfHeight;

    // Reapplied here (not left for the render loop's own resize check)
    // so recenter() visibly resets the view immediately even when the
    // panel's on-screen size hasn't changed since the last frame.
    const canvas = this.canvasRefs?.get(i)?.nativeElement;
    if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      const aspect = canvas.clientWidth / canvas.clientHeight;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
    }

    const controls = this.controls[i];
    controls.target.copy(this.framingCenter);
    // OrbitControls derives its internal pan/zoom state from the camera's
    // CURRENT position/target the first time it's asked to move it -
    // without this, the next drag/scroll on this panel would jump from
    // whatever stale internal state was left over from before instead of
    // continuing smoothly from here.
    controls.update();
  }

  // The on-panel "recenter" button - resets just THIS ONE panel's pan/zoom
  // back to the shared framing, leaving the other 5 panels' own pan/zoom
  // untouched.
  recenter(i: number): void {
    this.applyFraming(i);
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    if (!this.viewReady) {
      return;
    }

    const source = this.overlay.active();
    if (source === null) {
      this.lastSource = null;
      this.teardownRenderers();
      return;
    }
    if (!this.ensureRenderersReady()) {
      return; // canvases not measurable yet - retry next frame
    }
    if (source !== this.lastSource) {
      this.lastSource = source;
      this.rebuildFraming(source.framingObjects);
    }

    // Hidden only for the duration of THIS component's own render() calls
    // below, then restored - the source World's own canvas keeps rendering
    // these with whatever visibility it actually has (see SixViewSource's
    // doc comment).
    const previousVisibility = source.hiddenDuringView.map(object => object.visible);
    source.hiddenDuringView.forEach(object => (object.visible = false));

    const canvases = this.canvasRefs.toArray();
    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i].nativeElement;
      const { clientWidth: width, clientHeight: height } = canvas;
      if (width === 0 || height === 0) {
        continue;
      }
      const camera = this.cameras[i];
      const size = this.lastPanelSizes[i];
      if (size.width !== width || size.height !== height) {
        size.width = width;
        size.height = height;
        const aspect = width / height;
        const halfHeight = this.cameraHalfHeights[i];
        camera.left = -halfHeight * aspect;
        camera.right = halfHeight * aspect;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.updateProjectionMatrix();
        this.renderers[i].setSize(width, height);
        this.oitRenderers[i].setSize(width, height);
      }
      this.controls[i].update();
      this.oitRenderers[i].render(source.scene, camera);
    }

    source.hiddenDuringView.forEach((object, i) => (object.visible = previousVisibility[i]));
  };
}
