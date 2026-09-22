import { AfterViewInit, Component, ElementRef, OnDestroy, QueryList, ViewChildren, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SixViewOverlayService, SixViewSource } from '../../state/six-view-overlay.service';
import { WeightedOitRenderer } from '../../rendering/weighted-oit';
import { WebglContextBudgetService } from '../../state/webgl-context-budget.service';
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
  imports: [NgFor, NgIf],
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
  private readonly webglBudget = inject(WebglContextBudgetService);

  // Nullable, one slot per panel - unlike the old "all empty or all full"
  // batch model, each panel's renderer/oit/camera/controls bundle is
  // created independently, the first time ITS OWN canvas measures
  // non-zero and its own WebGLRenderer construction succeeds. The old
  // all-or-nothing model meant one permanently-broken panel (its context
  // genuinely evicted and never restored - see panelGeneration's own
  // comment) blocked EVERY other panel from ever finishing setup, AND every
  // failed retry disposed and reconstructed the OTHER, perfectly fine
  // panels' real WebGL contexts too - a retry storm that itself evicted
  // contexts elsewhere in the app every single frame, confirmed live via a
  // flood of "WARNING: Too many active WebGL contexts" console warnings.
  private readonly renderers: (THREE.WebGLRenderer | null)[] = VIEW_DIRECTIONS.map(() => null);
  // Same stable STL+voxel transparency fix as WorldCanvasComponent's own
  // main view (rendering/weighted-oit.ts) - one instance per panel, since
  // each panel is its own WebGLRenderer/WebGL context.
  private readonly oitRenderers: (WeightedOitRenderer | null)[] = VIEW_DIRECTIONS.map(() => null);
  private readonly cameras: (THREE.OrthographicCamera | null)[] = VIEW_DIRECTIONS.map(() => null);
  // Pan (screen-space, rotation disabled) + zoom per panel - independent
  // per camera, so dragging/scrolling one panel never affects the other 5.
  private readonly controls: (OrbitControls | null)[] = VIEW_DIRECTIONS.map(() => null);
  // Orthographic frustum half-height per camera - world units, independent
  // of each panel's aspect ratio (which the render loop applies on top of
  // this) and of the user's own zoom (OrbitControls drives camera.zoom
  // separately - see rebuildFraming). Parallel array to `cameras`, indexed
  // the same way.
  private readonly cameraHalfHeights: number[] = VIEW_DIRECTIONS.map(() => 1);
  private readonly lastPanelSizes: { width: number; height: number }[] = VIEW_DIRECTIONS.map(() => ({ width: 0, height: 0 }));
  // 0, not window.devicePixelRatio, deliberately - these renderers are
  // created lazily (ensurePanelReady, only once this tool is actually
  // open), so a mismatching sentinel here just means "not set up yet",
  // same reasoning as lastPanelSizes starting at 0.
  private lastPixelRatio = 0;
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
  // Same reasoning as ZonePaintingComponent's own onContextRestoredHandlers -
  // one closure per panel, added in ensureRenderersReady, removed again in
  // teardownRenderers. Without this, preventDefault() alone only asked the
  // browser to attempt a restore - nobody was listening for it actually
  // happening, so even a browser-restored context stayed a frozen/blank
  // panel forever.
  private readonly onContextRestoredHandlers: Array<() => void> = [];
  // Same reasoning as ZonePaintingComponent's own panelGeneration/
  // recreatingPanel/lastAttemptedCanvas/trackPanel - bumped only when a
  // canvas's context was evicted and never came back, forcing Angular to
  // hand that ONE panel a genuinely new <canvas> element. The template used
  // to hardcode 6 separate panel blocks (no *ngFor) - converted to one
  // *ngFor over panelIndices so trackBy can target a single panel instead of
  // the whole grid (which already gets a fresh set of 6 canvases on every
  // close/reopen via its own outer *ngIf, a different, already-safe
  // mechanism this doesn't change).
  readonly panelIndices = VIEW_DIRECTIONS.map((_, i) => i);
  // "+Y (зверху)"/"-Y (знизу)" carry an extra hint the other 4 don't -
  // looking straight down/up is the one pair of views a user could
  // otherwise mix up with a side view at a glance.
  private readonly PANEL_DISPLAY_LABELS: readonly string[] = ['+X', '-X', '+Y (зверху)', '-Y (знизу)', '+Z', '-Z'];
  panelLabel(i: number): string {
    return this.PANEL_DISPLAY_LABELS[i];
  }
  private readonly panelGeneration: number[] = VIEW_DIRECTIONS.map(() => 0);
  private readonly recreatingPanel: boolean[] = VIEW_DIRECTIONS.map(() => false);
  private readonly lastAttemptedCanvas: (HTMLCanvasElement | null)[] = VIEW_DIRECTIONS.map(() => null);
  trackPanel = (_: number, i: number): string => `${i}-${this.panelGeneration[i]}`;
  // Plain data, not live three.js objects - mid-session context-loss
  // recovery only (see ZonePaintingComponent's own savedCameraStates for the
  // full reasoning). Updated every frame.
  private readonly savedCameraStates: Array<{ position: THREE.Vector3; target: THREE.Vector3; zoom: number } | null> = VIEW_DIRECTIONS.map(
    () => null
  );

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

  // Sets up panel i's whole bundle (renderer/oit/camera/controls) the first
  // time its canvas measures non-zero, independently of every other panel -
  // see the fields' own comment for why this replaced the old all-or-
  // nothing batch. Returns whether panel i is ready to render THIS frame.
  private ensurePanelReady(i: number, canvas: HTMLCanvasElement): boolean {
    if (this.renderers[i]) {
      return true;
    }
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return false; // not measurable yet - retry next frame
    }
    if (this.recreatingPanel[i]) {
      if (canvas === this.lastAttemptedCanvas[i]) {
        return false; // still the old element - Angular hasn't swapped it in yet
      }
      this.recreatingPanel[i] = false;
    }
    this.lastAttemptedCanvas[i] = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    const onRestored = () => this.restorePanelAfterContextLoss(i);
    this.onContextRestoredHandlers[i] = onRestored;
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    let renderer: THREE.WebGLRenderer;
    try {
      // logarithmicDepthBuffer matters more here than on the main World
      // canvases: a large loaded model can push the near:far ratio (see
      // rebuildFraming) well past what a plain depth buffer can resolve,
      // which reads as the model's far side being incorrectly z-culled -
      // "the camera doesn't see far enough" - rather than an actual near/
      // far clipping-plane miss. Same fix WorldCanvasComponent's own
      // renderer already uses, for the same reason.
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    } catch (error) {
      // The browser doesn't always fire webglcontextrestored for an evicted
      // context (the spec never guarantees it) - recreating this ONE
      // panel's <canvas> element (via panelGeneration) is the only way to
      // guarantee a fresh, non-evicted context. Only THIS panel is affected
      // - the other 5, if already ready, are untouched.
      console.error(
        `[SixViewOverlayComponent] panel ${i}'s canvas context was evicted and never restored by the browser - recreating its <canvas> element to force a fresh context`,
        error
      );
      this.evictPanel(i);
      return false;
    }
    // Without this, three.js defaults every renderer to a pixel ratio of 1
    // regardless of the actual display - sharp on a plain 1x monitor, but
    // visibly soft/pixelated on anything HiDPI (Retina, most modern
    // external monitors too).
    renderer.setPixelRatio(this.lastPixelRatio || window.devicePixelRatio);
    this.renderers[i] = renderer;
    // Registers this panel's real context against the app-wide budget - see
    // WebglContextBudgetService's own header comment. May proactively evict
    // some OTHER, currently-idle panel's context (via ITS OWN evictPanel
    // callback) right here, if the app-wide cap is already reached - that's
    // the whole point, replacing the browser's own unpredictable eviction
    // with a deterministic, app-controlled one.
    this.webglBudget.register(`six-view-${i}`, () => this.evictPanel(i));
    this.oitRenderers[i] = new WeightedOitRenderer(renderer);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    this.cameras[i] = camera;
    const controls = new OrbitControls(camera, canvas);
    controls.enableRotate = false;
    controls.screenSpacePanning = true;
    controls.enableDamping = false;
    // Left-drag pans (not the default rotate, which enableRotate above
    // already blocks anyway) - the "move like in 2D, up/down/left/right"
    // behavior the user asked for shouldn't need a modifier key/middle
    // button to reach.
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls[i] = controls;
    this.cameraHalfHeights[i] = 1;
    this.lastPanelSizes[i].width = 0;
    this.lastPanelSizes[i].height = 0;
    // A fresh camera starts at THREE.OrthographicCamera's own construction
    // defaults, and a fresh OrbitControls defaults its target to (0,0,0) -
    // without this, the panel would silently snap to orbiting the world
    // origin from a meaningless position. framingCenter/framingRadius are
    // persistent fields already computed for the current source (or default
    // to origin/1 before any source has ever loaded), so this always lands
    // the panel somewhere sane immediately; animate()'s own recovery logic
    // then overrides this with savedCameraStates when appropriate.
    this.applyFraming(i);
    return true;
  }

  // Forces panel i to give up its real WebGL context right now - called
  // either reactively (ensurePanelReady's own catch, above, when the
  // browser already evicted it) or proactively (WebglContextBudgetService,
  // when the app-wide context cap is reached and this panel is the
  // least-recently-used one). Either way, the only way to guarantee a
  // genuinely fresh, non-evicted context later is a genuinely new <canvas>
  // DOM element - bumping panelGeneration forces Angular to hand this ONE
  // panel one via the template's own *ngFor/trackBy, same mechanism as
  // ZonePaintingComponent/SurfaceZonePaintingComponent/ZonePreviewComponent's
  // own equivalents. Safe to call on a panel that was never actually
  // constructed yet (this.renderers[i] still null) - the dispose block
  // below is skipped, only the generation bump/budget unregister happen.
  private evictPanel(i: number): void {
    const renderer = this.renderers[i];
    if (renderer) {
      const canvas = this.canvasRefs?.get(i)?.nativeElement;
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', this.onContextLost);
        const onRestored = this.onContextRestoredHandlers[i];
        if (onRestored) {
          canvas.removeEventListener('webglcontextrestored', onRestored);
        }
      }
      this.controls[i]?.dispose();
      this.oitRenderers[i]?.dispose();
      renderer.dispose();
      this.renderers[i] = null;
      this.oitRenderers[i] = null;
      this.cameras[i] = null;
      this.controls[i] = null;
    }
    this.onContextRestoredHandlers[i] = undefined as unknown as () => void;
    this.recreatingPanel[i] = true;
    this.panelGeneration[i]++;
    this.webglBudget.unregister(`six-view-${i}`);
  }

  private teardownRenderers(): void {
    for (let i = 0; i < VIEW_DIRECTIONS.length; i++) {
      const renderer = this.renderers[i];
      if (!renderer) {
        continue;
      }
      const canvas = this.canvasRefs?.get(i)?.nativeElement;
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', this.onContextLost);
        const onRestored = this.onContextRestoredHandlers[i];
        if (onRestored) {
          canvas.removeEventListener('webglcontextrestored', onRestored);
        }
      }
      this.onContextRestoredHandlers[i] = undefined as unknown as () => void;
      this.controls[i]?.dispose();
      this.oitRenderers[i]?.dispose();
      // dispose() only, deliberately NOT forceContextLoss() - these 6
      // <canvas> elements are never removed from the DOM (this component is
      // mounted once and only ever [hidden]), so the SAME canvas gets reused
      // on the next open. forceContextLoss() permanently kills a canvas's
      // context (only reachable again via forceContextRestore(), which this
      // code never calls) - a later `new THREE.WebGLRenderer({ canvas })` on
      // that same canvas would then read capabilities off a dead context and
      // throw ("Cannot read properties of null (reading 'precision')"),
      // which is exactly what happened when this called forceContextLoss()
      // here. dispose() alone doesn't lose the context - a canvas that
      // already has one just hands the SAME live context back to the next
      // WebGLRenderer created on it, so reopening stays safe.
      renderer.dispose();
      this.renderers[i] = null;
      this.oitRenderers[i] = null;
      this.cameras[i] = null;
      this.controls[i] = null;
    }
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
    const controls = this.controls[i];
    if (!camera || !controls) {
      return; // panel i hasn't been created yet - ensurePanelReady calls this itself once it has
    }
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

  // Plain-data snapshot of panel i's current camera/controls, kept up to
  // date every frame - mid-session context-loss recovery only (see
  // ZonePaintingComponent's own saveCameraState for the full reasoning).
  private saveCameraState(i: number, camera: THREE.OrthographicCamera, controls: OrbitControls): void {
    let saved = this.savedCameraStates[i];
    if (!saved) {
      saved = { position: new THREE.Vector3(), target: new THREE.Vector3(), zoom: 1 };
      this.savedCameraStates[i] = saved;
    }
    saved.position.copy(camera.position);
    saved.target.copy(controls.target);
    saved.zoom = camera.zoom;
  }

  // Fired when the browser actually restores a lost context on panel i -
  // see ZonePaintingComponent's own restorePanelAfterContextLoss for the
  // full reasoning.
  private restorePanelAfterContextLoss(i: number): void {
    const renderer = this.renderers[i];
    const camera = this.cameras[i];
    const controls = this.controls[i];
    const canvas = this.canvasRefs?.get(i)?.nativeElement;
    const source = this.overlay.active();
    if (!renderer || !camera || !controls || !canvas || !source || canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return;
    }
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.oitRenderers[i]?.setSize(canvas.clientWidth, canvas.clientHeight);
    const saved = this.savedCameraStates[i];
    if (saved) {
      camera.position.copy(saved.position);
      camera.zoom = saved.zoom;
      camera.updateProjectionMatrix();
      controls.target.copy(saved.target);
      controls.update();
    }
    this.oitRenderers[i]?.render(source.scene, camera);
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
    const sourceChanged = source !== this.lastSource;
    if (sourceChanged) {
      this.lastSource = source;
      this.rebuildFraming(source.framingObjects);
    }

    // Hidden only for the duration of THIS component's own render() calls
    // below, then restored - the source World's own canvas keeps rendering
    // these with whatever visibility it actually has (see SixViewSource's
    // doc comment). The restore is in a `finally`, not just after the loop,
    // so a panel throwing mid-loop (below) can never leave the source
    // World's grid/gizmo permanently hidden - without that, the ONE bad
    // panel would silently break the main canvas's own visuals well after
    // this overlay is closed again.
    const previousVisibility = source.hiddenDuringView.map(object => object.visible);
    source.hiddenDuringView.forEach(object => (object.visible = false));

    try {
      // Same "monitor's own pixel ratio changed underneath us" check as
      // WorldCanvasComponent.checkResize's own comment - dragging the
      // window to a display with a different scale factor doesn't
      // necessarily change any panel's CSS width/height at all, so the
      // per-panel size-diff check below would never notice on its own.
      // Resetting lastPanelSizes here forces every panel through that
      // check again this frame, picking up the new pixel ratio.
      const pixelRatio = window.devicePixelRatio;
      if (pixelRatio !== this.lastPixelRatio) {
        this.lastPixelRatio = pixelRatio;
        this.renderers.forEach(renderer => renderer?.setPixelRatio(pixelRatio));
        this.lastPanelSizes.forEach(size => {
          size.width = 0;
          size.height = 0;
        });
      }

      const canvases = this.canvasRefs.toArray();
      for (let i = 0; i < canvases.length; i++) {
        // Each panel renders (and gets set up) in its own try/catch - one
        // panel's bad frame, or one panel's canvas being permanently stuck
        // waiting on a context that will never come back, must never stop
        // the other 5 from rendering (see WorldCanvasComponent's own
        // animate() for why an uncaught throw here reads as "canvas goes
        // white forever").
        try {
          const canvas = canvases[i].nativeElement;
          const { clientWidth: width, clientHeight: height } = canvas;
          if (width === 0 || height === 0) {
            continue;
          }
          // Captured BEFORE ensurePanelReady so a recovery-from-context-loss
          // (this ONE panel's renderer going null -> non-null without the
          // source ever changing) still runs the same saved-state restore a
          // genuine mid-session recovery needs - without this, a recovered
          // panel's freshly (re)created camera would be left at whatever
          // default ensurePanelReady's own applyFraming call gave it,
          // discarding the user's actual pan/zoom.
          const wasReady = this.renderers[i] !== null;
          if (!this.ensurePanelReady(i, canvas)) {
            continue; // this panel isn't ready yet - the others still render
          }
          const camera = this.cameras[i]!;
          const controls = this.controls[i]!;
          const renderer = this.renderers[i]!;
          const oit = this.oitRenderers[i]!;
          if (!wasReady && !sourceChanged) {
            const saved = this.savedCameraStates[i];
            if (saved) {
              camera.position.copy(saved.position);
              camera.zoom = saved.zoom;
              camera.updateProjectionMatrix();
              controls.target.copy(saved.target);
              controls.update();
            }
          }
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
            renderer.setSize(width, height);
            oit.setSize(width, height);
          }
          controls.update();
          this.saveCameraState(i, camera, controls);
          this.webglBudget.touch(`six-view-${i}`);
          oit.render(source.scene, camera);
        } catch (error) {
          console.error(`[SixViewOverlayComponent] panel ${i} failed to render, skipping it this frame`, error);
        }
      }
    } finally {
      source.hiddenDuringView.forEach((object, i) => (object.visible = previousVisibility[i]));
    }
  };
}
