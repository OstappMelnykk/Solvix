import { AfterViewInit, Component, ElementRef, OnDestroy, QueryList, ViewChildren, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Axis, AXES, ZoneCellState, ZonePaintingService, axisCoords, projectedCoords } from '../../state/zone-painting.service';
import { labelConnectedComponents } from '../../state/mask-connectivity';
import { voxelCenter } from '../../geometry/voxel-grid-contract';
import { getVoxelCellByInstanceId } from '../../geometry/scene-objects/voxels';
import { buildZoneOverlayGroup, disposeZoneOverlayGroup, setZoneOverlayOpacity, darkenZoneColorCss } from '../../geometry/scene-objects/zone-overlay';
import { WeightedOitRenderer } from '../../rendering/weighted-oit';
import { VoxelizationService } from '../../state/voxelization.service';
import { ImportedReferenceDisplayService } from '../../state/imported-reference-display.service';
import { SurfaceZonePaintingService } from '../../state/surface-zone-painting.service';
import { NotificationService } from '../../state/notification.service';
import { WebglContextBudgetService } from '../../state/webgl-context-budget.service';

type AxisSign = 1 | -1;

const CLICK_MOVE_THRESHOLD_PX = 4;

const AVAILABLE_FILL = 'rgba(180, 185, 190, 0.35)';
const EXCLUDED_FILL = 'rgba(10, 10, 12, 0.55)';
// The pending mask's FIRST connected component keeps the normal
// zone-colored pending fill (fillFor's own 'pending' case) - these are for
// every ADDITIONAL disconnected "island" (2nd, 3rd, ...), a direct visual
// hint on the geometry itself for what would otherwise only surface as a
// text error at "Завершити зону" ("Виділення розірвано на кілька
// ділянок..."): distinct, attention-grabbing colors so the user can see
// AT A GLANCE which separate blobs still need to be bridged together, and
// tell them apart from each other while they're at it. Cycles if there
// somehow end up being more than 3 islands at once.
const DISCONNECTED_ISLAND_FILLS: readonly string[] = ['rgba(230, 57, 70, 0.65)', 'rgba(255, 190, 11, 0.65)', 'rgba(131, 56, 236, 0.65)'];

// Panels 0-2 are the fixed X/Y/Z painting views; panel 3 is a free-orbit "3D
// result" preview - the same real Scene, colored zones baked onto their
// actual voxel cubes (ZonePaintingComponent.rebuildZoneOverlayMesh), so the
// user can inspect the whole result in 3D instead of only as 3 flat
// projections.
const PANEL_COUNT = 4;
const RESULT_PANEL_INDEX = 3;

function eyeFor(axis: Axis, sign: AxisSign): THREE.Vector3 {
  if (axis === 'x') {
    return new THREE.Vector3(sign, 0, 0);
  }
  if (axis === 'y') {
    return new THREE.Vector3(0, sign, 0);
  }
  return new THREE.Vector3(0, 0, sign);
}

// Looking straight down/up world Y can't serve as its own up vector
// (parallel to the view direction) - Z stands in, flipping with the side
// chosen so "up" on screen stays consistent. X/Z views keep plain world-up.
function upFor(axis: Axis, sign: AxisSign): THREE.Vector3 {
  return axis === 'y' ? new THREE.Vector3(0, 0, -sign) : new THREE.Vector3(0, 1, 0);
}

function withAlpha(hexColor: string, alpha: number): string {
  const value = parseInt(hexColor.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// docs/local-refinement/PROBLEMS.md, Проблема 2, Варіант D. Always shows
// exactly 3 panels, one per axis (X, Y, Z) - no separate "pick 3 of 6"
// screen: which SIDE each panel looks from is just a +/- toggle on that
// same panel, switchable any time, without ever leaving the painting view.
// Each panel is a REAL orthographic camera rendering the session's actual
// live Scene (same approach as SixViewOverlayComponent - not a clone, not a
// synthetic reconstruction), with a colored 2D selection overlay drawn on
// top, projected through that same camera so it lines up with the real
// cubes underneath.
@Component({
  selector: 'app-zone-painting',
  standalone: true,
  imports: [NgFor, NgIf],
  host: { '[hidden]': 'isHidden()' },
  templateUrl: './zone-painting.component.html',
  styleUrl: './zone-painting.component.scss'
})
export class ZonePaintingComponent implements AfterViewInit, OnDestroy {
  @ViewChildren('canvas') private canvasRefs!: QueryList<ElementRef<HTMLCanvasElement>>;
  @ViewChildren('overlay') private overlayRefs!: QueryList<ElementRef<HTMLCanvasElement>>;

  private readonly zonePainting = inject(ZonePaintingService);
  private readonly voxelization = inject(VoxelizationService);
  private readonly referenceDisplay = inject(ImportedReferenceDisplayService);
  private readonly surfaceZonePainting = inject(SurfaceZonePaintingService);
  private readonly notifications = inject(NotificationService);
  private readonly webglBudget = inject(WebglContextBudgetService);

  readonly axes = AXES; // panels 0-2 always show axes[i] - fixed, only the side (sign) is switchable
  readonly panelIndices = Array.from({ length: PANEL_COUNT }, (_, i) => i); // 0-2 painting views, 3 the free-orbit result

  private panelSign: Record<Axis, AxisSign> = { x: 1, y: 1, z: 1 };
  private viewStateCache: Partial<Record<Axis, { width: number; height: number; cells: ZoneCellState[] }>> = {};

  // Nullable, one slot per panel - unlike an old "all empty or all full"
  // batch model, each panel's renderer/oit/camera/controls bundle is
  // created independently, the first time ITS OWN canvas measures
  // non-zero and its own WebGLRenderer construction succeeds. An
  // all-or-nothing batch model means one permanently-broken panel (its
  // context genuinely evicted and never restored - see panelGeneration's
  // own comment) blocks EVERY other panel from ever finishing setup, AND
  // every failed retry disposes and reconstructs the OTHER, perfectly fine
  // panels' real WebGL contexts too - a retry storm that itself evicts
  // contexts elsewhere in the app every single frame (confirmed live on
  // SixViewOverlayComponent via a flood of "Too many active WebGL
  // contexts" console warnings before this same fix was applied here).
  private readonly renderers: (THREE.WebGLRenderer | null)[] = new Array(PANEL_COUNT).fill(null);
  // Same stable STL+voxel transparency fix as WorldCanvasComponent's own
  // main view (rendering/weighted-oit.ts) - one instance per panel (4 here:
  // the 3 fixed-axis painting views plus the free-orbit 3D result), since
  // each panel is its own WebGLRenderer/WebGL context.
  private readonly oitRenderers: (WeightedOitRenderer | null)[] = new Array(PANEL_COUNT).fill(null);
  private readonly cameras: (THREE.OrthographicCamera | null)[] = new Array(PANEL_COUNT).fill(null);
  private readonly controls: (OrbitControls | null)[] = new Array(PANEL_COUNT).fill(null);
  private readonly cameraHalfHeights: number[] = new Array(PANEL_COUNT).fill(1);
  private readonly lastPanelSizes: { width: number; height: number }[] = Array.from({ length: PANEL_COUNT }, () => ({ width: 0, height: 0 }));
  // 0, not window.devicePixelRatio, deliberately - these renderers are
  // created lazily (ensureRenderersReady, only once this tool is actually
  // open), so a mismatching sentinel here just means "not set up yet",
  // same reasoning as lastPanelSizes starting at 0.
  private lastPixelRatio = 0;
  private readonly framingCenter = new THREE.Vector3();
  private framingRadius = 1;
  private lastSessionId: number | null = null;
  // Unlike lastSessionId (force-reset to null on every wizard-step hide, see
  // animate's own comment, so "reopened" and "genuinely new session" look
  // identical there), this one is ONLY ever written inside the reset block
  // below - it's what actually distinguishes "same document session,
  // reopened for another zone" (restore the remembered camera/panelSign)
  // from "switched to a different CAD session entirely" (that remembered
  // view has nothing to do with the new model - discard it).
  private lastKnownSessionId: number | null = null;
  // Plain data, not live three.js objects - deliberately NOT trying to keep
  // the SAME camera/OrbitControls instances alive across a canvas
  // destroy/recreate cycle (that approach broke rendering 3 separate times
  // - see [[project_webgl_context_architecture]]). Instead: a fresh
  // camera/controls pair is always created from scratch (ensureRenderersReady,
  // unchanged), and animate()'s reset block just copies these plain numbers
  // onto it afterward. Updated every frame (saveCameraState) so it always
  // holds the user's latest manual pan/zoom/rotate, not just the initial
  // default framing.
  private readonly savedCameraStates: Array<{ position: THREE.Vector3; target: THREE.Vector3; zoom: number } | null> = new Array(
    PANEL_COUNT
  ).fill(null);
  private savedPanelSign: Record<Axis, AxisSign> | null = null;
  private frameId = 0;
  private viewReady = false;
  // Without preventDefault() here, a lost WebGL context on any of these 4
  // canvases is PERMANENT - the browser only ever attempts to restore a
  // context whose loss event was explicitly prevented. Matches
  // WorldCanvasComponent's own long-standing handling, which these 4
  // canvases never had.
  private readonly onContextLost = (event: Event) => event.preventDefault();
  // One per panel (which panel index a given canvas is depends on where it
  // sits in canvasRefs, so a shared handler like onContextLost can't tell
  // them apart) - populated in ensureRenderersReady, used again in
  // teardownRenderers to remove the exact same closures. Without this,
  // restorePanelAfterContextLoss never ran for ANY of these 4 canvases
  // (preventDefault() alone only asks the browser to attempt a restore -
  // nobody was listening for it actually happening), so even a
  // browser-restored context stayed a frozen/blank frame forever.
  private readonly onContextRestoredHandlers: Array<() => void> = [];
  // Bumped only when a canvas's context was evicted by the browser and never
  // came back (webglcontextrestored never fires - happens in practice, the
  // spec doesn't guarantee it) - the ONLY way to get a genuinely fresh,
  // non-evicted WebGL context on a dead canvas is a genuinely new <canvas>
  // DOM element. trackPanel below ties each panel's *ngFor identity to its
  // own generation counter, so bumping panel i's forces Angular itself to
  // destroy and recreate JUST that one panel's DOM subtree (and update its
  // own view/query bookkeeping correctly) - a manual DOM replaceWith() was
  // considered and rejected: it would desync canvasRefs from what Angular's
  // queries actually track internally, silently reverting on the very next
  // change detection pass. Normal open/close never touches this (all start
  // and stay at 0), so this can't reproduce the 3 previously-confirmed
  // rendering regressions from *ngIf-driven WHOLE-grid, EVERY-hide/show
  // churn - see [[project_webgl_context_architecture]] - this is a single
  // panel, only on a genuinely unrecoverable context loss.
  private readonly panelGeneration: number[] = new Array(PANEL_COUNT).fill(0);
  // Set for panel i right after bumping its generation above, cleared once
  // ensureRenderersReady notices canvasRefs.get(i) actually points at a
  // different element than lastAttemptedCanvas[i] - i.e. Angular has
  // actually finished swapping it in. Without this, ensureRenderersReady
  // would keep retrying (and re-throwing on) the SAME still-old, still-dead
  // canvas every single frame until Angular catches up.
  private readonly recreatingPanel: boolean[] = new Array(PANEL_COUNT).fill(false);
  private readonly lastAttemptedCanvas: (HTMLCanvasElement | null)[] = new Array(PANEL_COUNT).fill(null);

  // Angular's own trackBy for the panel *ngFor - see panelGeneration's own
  // comment for why. Non-private (template-bound).
  trackPanel = (_: number, i: number): string => `${i}-${this.panelGeneration[i]}`;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private dragPanelIndex: number | null = null;
  private dragDownClient: { x: number; y: number } | null = null;
  private dragStart: { u: number; v: number } | null = null;
  private dragCurrent: { u: number; v: number } | null = null;

  // Rebuilt whenever the set of committed zones changes (rebuildZoneOverlayMesh) -
  // one colored box per zoned voxel, added to the shared Scene but kept
  // hidden except during the result panel's own render() call (see animate),
  // so panels 0-2 (which show their own flat 2D overlay instead) never see
  // it doubled up on top of the real cubes.
  // One InstancedMesh PER ZONE (not per-instance color on a single shared
  // mesh) - see rebuildZoneOverlayMesh's own comment for why.
  private zoneOverlayGroup: THREE.Group | null = null;

  // Deliberately does NOT create the 4 WebGLRenderers here - this used to,
  // but that (plus SixViewOverlayComponent's 6, always-mounted since app
  // boot) already left little headroom before the browser's per-page WebGL
  // context limit (commonly 16 in Chrome): 3 worlds + 6 six-view + 4 here =
  // 13, and the moment SurfaceZonePaintingComponent's OWN 4 (step 2) are
  // ALSO created while this tool happened to still be holding its 4, the
  // total (17) went over the limit and silently lost an EARLIER context
  // instead (the Ideal World canvas going blank - a real, reported
  // regression). Since this component and SurfaceZonePaintingComponent are
  // never meant to be open at the same time (opening one closes the
  // other), making BOTH lazy (create on open, free on close) means their 4
  // contexts never coexist - worst case stays 3 + 6 + 4 = 13, safely under
  // the limit regardless of which of the 2 painting steps is open.
  ngAfterViewInit(): void {
    this.viewReady = true;
    this.animate();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.teardownRenderers();
    this.disposeZoneOverlayMesh();
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
    // If a previous frame flagged panel i as awaiting a fresh <canvas>
    // (the catch block below), wait until Angular has actually swapped the
    // element out before trying again - otherwise this would just throw on
    // the exact same still-dead canvas every single frame.
    if (this.recreatingPanel[i]) {
      if (canvas === this.lastAttemptedCanvas[i]) {
        return false;
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
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    } catch (error) {
      // A canvas whose context the browser already evicted (too many
      // WebGL contexts open across the app at once) throws here instead
      // of returning a usable renderer, and in practice the browser does
      // not always fire webglcontextrestored for an evicted context (the
      // spec never guarantees it) - so unlike a transient loss, this one
      // may just stay dead forever on its own. Bumping panelGeneration[i]
      // (see its own comment) forces Angular to hand this ONE panel a
      // genuinely new <canvas> element next change detection pass, which
      // is guaranteed a fresh, non-evicted context. Only THIS panel is
      // affected - the other 3, if already ready, are left untouched.
      console.error(
        `[ZonePaintingComponent] panel ${i}'s canvas context was evicted and never restored by the browser - recreating its <canvas> element to force a fresh context`,
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
    // See WebglContextBudgetService's own header comment - may proactively
    // evict some OTHER, currently-idle panel (this component's own, or a
    // different tool's) to stay under the app-wide context cap.
    this.webglBudget.register(`zone-painting-${i}`, () => this.evictPanel(i));
    this.oitRenderers[i] = new WeightedOitRenderer(renderer);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    this.cameras[i] = camera;
    const controls = new OrbitControls(camera, canvas);
    controls.screenSpacePanning = true;
    controls.enableDamping = false;
    if (i === RESULT_PANEL_INDEX) {
      // Free-orbit preview - default OrbitControls behavior (left rotates,
      // wheel/middle zooms, right pans).
      controls.enableRotate = true;
    } else {
      // Fixed-axis painting panels never rotate. LEFT is deliberately left
      // unmapped - this app's own pointer handlers (onPointerDown/Move/Up
      // below) use plain left-click/drag to paint zones, so OrbitControls
      // must not also react to it. Pan/zoom still work via right-drag /
      // wheel-drag.
      controls.enableRotate = false;
      controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    }
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls[i] = controls;
    this.lastPanelSizes[i].width = 0;
    this.lastPanelSizes[i].height = 0;
    // A fresh camera starts at THREE.OrthographicCamera's own construction
    // defaults, and a fresh OrbitControls defaults its target to (0,0,0) -
    // without this, the panel would silently snap to orbiting the world
    // origin from a meaningless position. framingCenter/framingRadius/
    // panelSign are persistent fields already computed for the current
    // session (or their construction-time defaults before any session has
    // ever loaded), so this always lands the panel somewhere sane
    // immediately; animate()'s own recovery logic then overrides this with
    // savedCameraStates when appropriate.
    this.applyFraming(i);
    return true;
  }

  // Forces panel i to give up its real WebGL context right now - either
  // reactively (ensurePanelReady's own catch, above) or proactively
  // (WebglContextBudgetService, when the app-wide context cap is reached
  // and this panel is the least-recently-used one). See SixViewOverlayComponent's
  // own evictPanel for the full reasoning - same mechanism, adapted here.
  // Safe to call on a panel never actually constructed (this.renderers[i]
  // still null) - the dispose block is skipped.
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
    this.webglBudget.unregister(`zone-painting-${i}`);
  }

  private teardownRenderers(): void {
    for (let i = 0; i < PANEL_COUNT; i++) {
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
      // dispose() only, deliberately NOT forceContextLoss() - these 4
      // <canvas> elements are never removed from the DOM (this component is
      // mounted once and only ever [hidden]), so the SAME canvas gets reused
      // on the next open. forceContextLoss() permanently kills a canvas's
      // context, which made a later `new THREE.WebGLRenderer({ canvas })` on
      // reopen read capabilities off a dead context and throw. dispose()
      // alone doesn't lose the context - a canvas that already has one just
      // hands the SAME live context back to the next WebGLRenderer created
      // on it, so reopening stays safe.
      renderer.dispose();
      this.renderers[i] = null;
      this.oitRenderers[i] = null;
      this.cameras[i] = null;
      this.controls[i] = null;
    }
  }

  // Whether the WHOLE zone-painting wizard is closed - purely a template
  // gate (*ngIf on the canvas grid, see the template's own comment), rare
  // (once per "finished or cancelled this zone"). Deliberately separate
  // from isHidden() below, which flips constantly during normal use (every
  // wizard-step open/close) - isHidden()'s own existing teardown/rebuild
  // cycle in animate()/ensureRenderersReady is left completely untouched
  // here, still running on every one of those frequent toggles exactly as
  // before; this gate only ADDITIONALLY removes the canvas element (freeing
  // its real WebGL context) on the rarer full-session-close event.
  hasActiveSession(): boolean {
    return this.zonePainting.activeSessionId() !== null;
  }

  isHidden(): boolean {
    return this.zonePainting.activeSessionId() === null || !this.zonePainting.step1Visible();
  }

  isResultPanel(index: number): boolean {
    return index === RESULT_PANEL_INDEX;
  }

  axisLabel(index: number): string {
    if (index === RESULT_PANEL_INDEX) {
      return '3D результат';
    }
    const axis = this.axes[index];
    return (this.panelSign[axis] === 1 ? '+' : '-') + axis.toUpperCase();
  }

  flipSign(index: number): void {
    if (index === RESULT_PANEL_INDEX) {
      return;
    }
    const axis = this.axes[index];
    this.panelSign = { ...this.panelSign, [axis]: this.panelSign[axis] === 1 ? -1 : 1 };
    this.savedPanelSign = this.panelSign;
    this.applyFraming(index);
  }

  // Cancels this zone attempt - back to the list, not a full close (the
  // list's own session data is untouched, only step 1's canvas hides).
  close(): void {
    this.zonePainting.hideStep1();
  }

  coverageText(): string {
    const sessionId = this.zonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.zonePainting.coverage(sessionId);
    return coverage ? `Розмічено: ${coverage.assigned} / ${coverage.total} вокселів` : '';
  }

  // The sidebar's top status bar (zone-painting.component.html) - 0 rather
  // than NaN/100 when there's nothing occupied yet (coverage.total === 0),
  // so the bar starts empty instead of misleadingly full.
  coveragePercent(): number {
    const sessionId = this.zonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.zonePainting.coverage(sessionId);
    return coverage && coverage.total > 0 ? Math.round((coverage.assigned / coverage.total) * 100) : 0;
  }

  nextZoneColor(): string {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId === null ? '#888' : this.zonePainting.nextZoneColor(sessionId);
  }

  // Commits the current pending selection as this wizard invocation's ONE
  // zone. On success, hands off straight to step 2 (STL painting) for that
  // SAME zone and closes this step - there is no separate "Зберегти"/list
  // here anymore (ZoneListComponent owns the list of already-completed
  // zones; this view only ever has one zone in progress at a time).
  finishZone(): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const { assigned, disconnected } = this.zonePainting.finishZone(sessionId);
    this.refreshClassifications();
    this.rebuildZoneOverlayMesh();

    if (disconnected) {
      this.notifications.error('Виділення розірвано на кілька ділянок - з\'єднайте їх або завершіть частинами. Зона не створена.');
      return;
    }
    if (assigned === 0) {
      this.notifications.error('Перетин 3 областей порожній - жодного вокселя не додано. Зона не створена.');
      return;
    }

    // finishZone always appends the new zone at the end of a contiguous
    // 0..N-1 array (ZonePaintingService.deleteZone is the only other thing
    // that ever touches zone ids, and nothing can run concurrently with
    // this call), so the last entry is exactly the zone just committed.
    const zones = this.zonePainting.getSession(sessionId)?.zones ?? [];
    const newZoneId = zones[zones.length - 1]?.id;
    if (newZoneId === undefined) {
      return;
    }
    this.openStep2ForZone(sessionId, newZoneId);
  }

  // Hands the just-committed zone off to SurfaceZonePaintingComponent (step
  // 2 of this same wizard) and closes this step, so only one full-screen
  // tool is ever showing at once (SurfaceZonePaintingComponent isn't nested
  // inside this one - it's a sibling, mounted once at app.component.html,
  // same pattern as this component itself and SixViewOverlayComponent).
  private openStep2ForZone(sessionId: number, voxelZoneId: number): void {
    const source = this.zonePainting.activeSource();
    if (!source || !source.stlMesh) {
      return;
    }
    const opened = this.surfaceZonePainting.open(sessionId, {
      scene: source.scene,
      stlMesh: source.stlMesh,
      framingObjects: [source.stlMesh],
      // The voxel fill occupies roughly the same physical space as the STL
      // surface being clicked on here - left visible, it would visually
      // compete with (and occlude) the smooth surface the user is trying
      // to precisely click on. Combined with step 1's OWN hidden fixtures
      // (source.hiddenDuringView - the floor grid, rotate gizmo ring, and
      // dimension-lines/ruler overlays WorldCanvasComponent.previewFixtures
      // already computed for step 1) so step 2 hides the exact same clutter,
      // not just the voxel fill on its own.
      hiddenDuringView: [source.voxelPreview, ...source.hiddenDuringView],
      // Kept verbatim so SurfaceZonePaintingComponent's own "← Крок 1" back
      // button can re-open this exact same window later, without this
      // component needing to still be around to hand it over again.
      step1Source: source
    });
    if (opened) {
      this.surfaceZonePainting.setActiveVoxelZoneId(sessionId, voxelZoneId);
      // Hides step 1's canvas, NOT a full close - the list underneath stays
      // open with its session data intact, ready for the next zone.
      this.zonePainting.hideStep1();
    }
  }

  // Left button only - this used to react to EVERY pointer button, so a
  // right-drag pan gesture (OrbitControls' mouseButtons.RIGHT = PAN, set
  // above) was ALSO tracked as a paint attempt and fired a toggleCell/
  // selectRect the instant the button was released, fighting with the pan
  // itself instead of letting it through untouched.
  onPointerDown(index: number, event: PointerEvent): void {
    if (index === RESULT_PANEL_INDEX || event.button !== 0) {
      return;
    }
    this.dragPanelIndex = index;
    this.dragDownClient = { x: event.clientX, y: event.clientY };
    this.dragStart = null;
    this.dragCurrent = null;
    const cell = this.raycastCell(index, event);
    if (cell) {
      const axis = this.axes[index];
      this.dragStart = projectedCoords(axis, cell.ix, cell.iy, cell.iz);
      this.dragCurrent = this.dragStart;
    }
  }

  onPointerMove(index: number, event: PointerEvent): void {
    if (this.dragPanelIndex !== index || !this.dragStart) {
      return;
    }
    const cell = this.raycastCell(index, event);
    if (cell) {
      this.dragCurrent = projectedCoords(this.axes[index], cell.ix, cell.iy, cell.iz);
    }
  }

  onPointerUp(index: number): void {
    const downClient = this.dragDownClient;
    this.dragDownClient = null;
    const sessionId = this.zonePainting.activeSessionId();

    if (this.dragPanelIndex === index && sessionId !== null && this.dragStart && this.dragCurrent && downClient) {
      const axis = this.axes[index];
      const { u: u0, v: v0 } = this.dragStart;
      const { u: u1, v: v1 } = this.dragCurrent;
      const ok =
        u0 === u1 && v0 === v1
          ? this.zonePainting.toggleCell(sessionId, axis, u0, v0)
          : this.zonePainting.selectRect(sessionId, axis, u0, v0, u1, v1);
      if (!ok) {
        this.notifications.error('Нічого не змінено - клітинки вже зайняті іншою зоною або недоступні.');
      }
      this.refreshClassifications();
    }
    this.dragPanelIndex = null;
    this.dragStart = null;
    this.dragCurrent = null;
  }

  private raycastCell(index: number, event: PointerEvent): { ix: number; iy: number; iz: number } | null {
    const source = this.zonePainting.activeSource();
    const canvas = this.canvasRefs.get(index)?.nativeElement;
    if (!source || !canvas) {
      return null;
    }
    const batchedFill = source.voxelPreview.children.find((child): child is THREE.BatchedMesh => child instanceof THREE.BatchedMesh);
    const camera = this.cameras[index];
    if (!batchedFill || !camera) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, camera);
    const hit = this.raycaster.intersectObject(batchedFill)[0];
    if (!hit || hit.batchId === undefined) {
      return null;
    }
    const cell = getVoxelCellByInstanceId(source.voxelPreview, hit.batchId);
    return cell ? { ix: cell.ix, iy: cell.iy, iz: cell.iz } : null;
  }

  private refreshClassifications(): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    for (const axis of AXES) {
      this.viewStateCache[axis] = this.zonePainting.viewState(sessionId, axis);
    }
  }

  private rebuildFraming(framingObjects: readonly THREE.Object3D[]): void {
    const box = new THREE.Box3();
    framingObjects.forEach(object => box.expandByObject(object));
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
    this.framingCenter.copy(sphere.center);
    this.framingRadius = Math.max(sphere.radius, 0.01);
    this.cameras.forEach((_, i) => this.applyFraming(i));
  }

  private applyFraming(i: number): void {
    const camera = this.cameras[i];
    const controls = this.controls[i];
    if (!camera || !controls) {
      return; // panel i hasn't been created yet - ensurePanelReady calls this itself once it has
    }
    const radius = this.framingRadius;
    const distance = radius * 3;
    const halfHeight = radius * 1.15;

    if (i === RESULT_PANEL_INDEX) {
      // Free-orbit preview - a fixed isometric-ish starting angle, not tied
      // to any axis (the user rotates freely from here via OrbitControls).
      camera.position.copy(this.framingCenter).addScaledVector(new THREE.Vector3(1, 1, 1).normalize(), distance);
      camera.up.set(0, 1, 0);
    } else {
      const axis = this.axes[i];
      const sign = this.panelSign[axis];
      camera.position.copy(this.framingCenter).addScaledVector(eyeFor(axis, sign), distance);
      camera.up.copy(upFor(axis, sign));
    }
    camera.zoom = 1;
    camera.lookAt(this.framingCenter);
    camera.near = 0.1;
    camera.far = distance + radius * 10;
    this.cameraHalfHeights[i] = halfHeight;

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
    controls.update();
  }

  // Plain-data snapshot of panel i's current camera/controls, kept up to
  // date every frame - see savedCameraStates' own comment for why this
  // exists (restoring across a canvas recreation without keeping the old
  // camera/controls objects themselves alive). Reuses the same Vector3
  // instances across frames rather than allocating new ones every time.
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

  // Fired when the browser actually restores a lost context on panel i.
  // Three.js's own WebGLRenderer re-initializes its internal GL state
  // automatically on this event (see the constructor's own contextlost/
  // contextrestored wiring in three.js), but it never repaints on its own
  // and never reapplies viewport size or camera state - left alone, this
  // panel would just stay a frozen/blank frame until some unrelated trigger
  // forced a render. Reapplies this panel's own last-known plain-data
  // camera state (the same data animate()'s "new session" restore branch
  // uses) so a mid-session context loss doesn't cost the user their
  // pan/zoom/rotate, then forces one immediate render.
  private restorePanelAfterContextLoss(i: number): void {
    const renderer = this.renderers[i];
    const camera = this.cameras[i];
    const controls = this.controls[i];
    const canvas = this.canvasRefs?.get(i)?.nativeElement;
    if (!renderer || !camera || !controls || !canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) {
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
    const source = this.zonePainting.activeSource();
    if (source) {
      this.oitRenderers[i]?.render(source.scene, camera);
    }
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    if (!this.viewReady) {
      return;
    }
    const sessionId = this.zonePainting.activeSessionId();
    const source = this.zonePainting.activeSource();
    // step1Visible false means the list is showing instead (same sessionId,
    // same source, just this canvas hidden) - resetting lastSessionId here
    // (not just on an actual session change) forces the "just became
    // visible" branch below to re-run next time step 1 reopens for a NEW
    // zone, so it always picks up whatever the list did to the zone data
    // while this was hidden (a delete, a color edit, ...) instead of
    // drawing from a stale viewStateCache/zoneOverlayGroup.
    if (sessionId === null || !source || !this.zonePainting.step1Visible()) {
      this.lastSessionId = null;
      this.teardownRenderers();
      return;
    }
    const sessionChanged = sessionId !== this.lastSessionId;
    if (sessionChanged) {
      this.lastSessionId = sessionId;
      if (sessionId !== this.lastKnownSessionId) {
        // A genuinely different CAD session, not just this same one
        // reopened for another zone - the remembered camera/panelSign
        // belongs to a different model and would land the camera somewhere
        // meaningless relative to this one. Discard it; the framing below
        // recomputes fresh defaults as it always did.
        this.lastKnownSessionId = sessionId;
        this.savedCameraStates.fill(null);
        this.savedPanelSign = null;
      }
      // Restored BEFORE rebuildFraming (not after) so its own applyFraming
      // calls already use the right axis-flip direction, not the default
      // one it'd have to be corrected from a second time. Only touches
      // panels that are ALREADY ready this frame - a panel not yet created
      // (e.g. still recovering from a context loss) gets this same
      // panelSign/framing applied by ensurePanelReady's own applyFraming
      // call once it's created, later in the per-panel loop below.
      this.panelSign = this.savedPanelSign ? { ...this.savedPanelSign } : { x: 1, y: 1, z: 1 };
      this.rebuildFraming(source.framingObjects);
      this.refreshClassifications();
      this.rebuildZoneOverlayMesh();
    }

    // Restored in a `finally` below - see SixViewOverlayComponent's animate()
    // for why (a panel throwing mid-loop must never leave the source
    // World's grid/gizmo permanently hidden).
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
        // Each panel is set up (if needed) and rendered in its own
        // try/catch - see SixViewOverlayComponent's animate() for why (one
        // bad, or one permanently-stuck, panel must never stop the other 3
        // from rendering).
        try {
          const canvas = canvases[i].nativeElement;
          const { clientWidth: width, clientHeight: height } = canvas;
          if (width === 0 || height === 0) {
            continue;
          }
          const wasReady = this.renderers[i] !== null;
          if (!this.ensurePanelReady(i, canvas)) {
            continue; // this panel isn't ready yet - the others still render
          }
          const camera = this.cameras[i]!;
          const controls = this.controls[i]!;
          const renderer = this.renderers[i]!;
          const oit = this.oitRenderers[i]!;
          // Panel i just became ready this frame (either its very first
          // time, or recovering mid-session from a context loss) - override
          // whatever default position/zoom/target applyFraming just gave it
          // with the plain numbers saveCameraState kept up to date while it
          // was last open. savedCameraStates was already cleared above if
          // this is genuinely a different CAD session, so this is a no-op
          // in that case.
          if (!wasReady) {
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
          this.webglBudget.touch(`zone-painting-${i}`);
          // The colored-zone overlay mesh lives in the shared Scene but must
          // only be visible for the result panel's OWN render() call - panels
          // 0-2 show their flat 2D projection instead (drawOverlay below) and
          // would otherwise show the 3D boxes doubled up underneath it.
          if (this.zoneOverlayGroup) {
            this.zoneOverlayGroup.visible = i === RESULT_PANEL_INDEX;
          }
          oit.render(source.scene, camera);
          if (i !== RESULT_PANEL_INDEX) {
            this.drawOverlay(i, camera, width, height);
          }
        } catch (error) {
          console.error(`[ZonePaintingComponent] panel ${i} failed to render, skipping it this frame`, error);
        }
      }
      if (this.zoneOverlayGroup) {
        this.zoneOverlayGroup.visible = false;
      }
    } finally {
      source.hiddenDuringView.forEach((object, i) => (object.visible = previousVisibility[i]));
    }
  };

  // Rebuilds the result panel's colored-zone overlay from scratch - ONE
  // InstancedMesh PER ZONE (not one shared mesh with a per-instance color).
  // A per-instance color (InstancedMesh.setColorAt) rendered black/near-
  // black in practice; a plain `material.color` set directly in the
  // constructor is exactly the pattern scene-objects/voxels.ts's own edges/nodes/
  // highlight overlays already use successfully (EDGE_COLOR/NODE_COLOR/
  // HIGHLIGHT_COLOR), so each zone gets its own small InstancedMesh (one per
  // zone, not one per voxel) with a single solid color instead. Rebuilding
  // outright (rather than incrementally patching instances) is simplest and
  // cheap enough for a discrete user action like committing one zone.
  // Delegates the actual mesh-building to geometry/zone-overlay.ts, shared
  // with WorldCanvasComponent's own "Показати зони" button on the main
  // Ideal World view - one place computes the color/geometry, so the two
  // never drift into two subtly different-looking implementations.
  private rebuildZoneOverlayMesh(): void {
    this.disposeZoneOverlayMesh();
    const sessionId = this.zonePainting.activeSessionId();
    const source = this.zonePainting.activeSource();
    const session = sessionId !== null ? this.zonePainting.getSession(sessionId) : null;
    if (sessionId === null || !source || !session) {
      return;
    }
    const opacity = this.zonePainting.getZoneOverlayOpacity(sessionId);
    const group = buildZoneOverlayGroup(session.grid, session.zones, (ix, iy, iz) => this.zonePainting.zoneIdAt(sessionId, ix, iy, iz), opacity);
    if (!group) {
      return;
    }
    group.visible = false;
    source.scene.add(group);
    this.zoneOverlayGroup = group;
  }

  private disposeZoneOverlayMesh(): void {
    if (!this.zoneOverlayGroup) {
      return;
    }
    disposeZoneOverlayGroup(this.zoneOverlayGroup);
    this.zoneOverlayGroup = null;
  }

  // Backing value + action for the "Прозорість зон" slider - cheap live
  // update (setZoneOverlayOpacity just touches each material's opacity),
  // not a full rebuildZoneOverlayMesh, so dragging the slider stays smooth.
  zoneOverlayOpacity(): number {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId === null ? 0.75 : this.zonePainting.getZoneOverlayOpacity(sessionId);
  }

  setZoneOverlayOpacityFromInput(value: string): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const opacity = Number(value);
    this.zonePainting.setZoneOverlayOpacity(sessionId, opacity);
    if (this.zoneOverlayGroup) {
      setZoneOverlayOpacity(this.zoneOverlayGroup, opacity);
    }
  }

  // Direct opacity passthrough (no [0,1]<->percent inversion) - matches
  // imported-reference-controls.component.ts's own getVoxelOpacityPercent/
  // onVoxelOpacityChange and getReferenceOpacityPercent/onReferenceOpacityChange,
  // so the same slider position means the same thing here as it does on the
  // main settings panel. Zone painting only ever opens from the Ideal World
  // (openZonePainting's own gate), so - unlike SixViewOverlayComponent's
  // equivalent sliders - these never need an extra "is this the right
  // world" check.
  voxelOpacityPercent(): number {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId === null ? 0 : Math.round(this.voxelization.getOpacity(sessionId) * 100);
  }

  onVoxelOpacityChange(event: Event): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const percent = Number((event.target as HTMLInputElement).value);
    this.voxelization.setOpacity(sessionId, percent / 100);
  }

  referenceOpacityPercent(): number {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId === null ? 50 : Math.round(this.referenceDisplay.getStyle(sessionId).opacity * 100);
  }

  onReferenceOpacityChange(event: Event): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const percent = Number((event.target as HTMLInputElement).value);
    this.referenceDisplay.setOpacity(sessionId, percent / 100);
  }

  // The colored selection overlay - a plain 2D canvas stacked on top of the
  // WebGL one (see the .scss), drawn by projecting each 2D cell's
  // representative voxel through THIS panel's own real camera. Orthographic
  // projection has no parallax, so every voxel along the collapsed axis
  // lands on the same screen position - see axisCoords' own comment.
  private drawOverlay(index: number, camera: THREE.OrthographicCamera, width: number, height: number): void {
    const overlayCanvas = this.overlayRefs?.get(index)?.nativeElement;
    const sessionId = this.zonePainting.activeSessionId();
    if (!overlayCanvas || sessionId === null) {
      return;
    }
    if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
      overlayCanvas.width = width;
      overlayCanvas.height = height;
    }
    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, width, height);

    const axis = this.axes[index];
    const state = this.viewStateCache[axis];
    const session = this.zonePainting.getSession(sessionId);
    if (!state || !session) {
      return;
    }
    const { grid } = session;
    const pixelsPerWorldUnit = (width / (camera.right - camera.left)) * camera.zoom;
    const cellPixelSize = grid.cellSize * pixelsPerWorldUnit;
    const currentZoneColor = this.nextZoneColor();
    const projected = new THREE.Vector3();
    // Labels this axis's PENDING mask by connected component, so a
    // disconnected selection (allowed while painting - only rejected at
    // "Завершити зону") shows each separate island in its own color
    // instead of one uniform pending fill (see DISCONNECTED_ISLAND_FILLS'
    // own comment).
    const pendingMask = this.zonePainting.pendingMask(sessionId, axis);
    const pendingLabels = pendingMask ? labelConnectedComponents(pendingMask, state.width, state.height) : null;

    for (let v = 0; v < state.height; v++) {
      for (let u = 0; u < state.width; u++) {
        const cellState = state.cells[u + v * state.width];
        if (cellState.kind === 'empty') {
          continue;
        }
        const fill =
          cellState.kind === 'pending'
            ? this.pendingFillFor(currentZoneColor, pendingLabels?.labels[u + v * state.width] ?? 0)
            : this.fillFor(cellState, currentZoneColor);
        if (!fill) {
          continue;
        }
        const { ix, iy, iz } = axisCoords(axis, 0, u, v);
        const center = voxelCenter(grid, ix, iy, iz);
        projected.set(center.x, center.y, center.z).project(camera);
        const screenX = (projected.x * 0.5 + 0.5) * width;
        const screenY = (1 - (projected.y * 0.5 + 0.5)) * height;
        ctx.fillStyle = fill;
        ctx.fillRect(screenX - cellPixelSize / 2, screenY - cellPixelSize / 2, cellPixelSize, cellPixelSize);
      }
    }
  }

  private fillFor(state: ZoneCellState, currentZoneColor: string): string | null {
    switch (state.kind) {
      case 'empty':
        return null;
      case 'available':
        return AVAILABLE_FILL;
      case 'excluded':
        return EXCLUDED_FILL;
      case 'pending':
        return this.pendingFillFor(currentZoneColor, 0);
      case 'zoned':
        return darkenZoneColorCss(state.color);
    }
  }

  // component 0 (whichever island the flood fill happens to reach first -
  // not necessarily "the first one the user painted") keeps the normal
  // zone-colored pending fill; every later component cycles through
  // DISCONNECTED_ISLAND_FILLS instead - see that constant's own comment.
  private pendingFillFor(currentZoneColor: string, component: number): string {
    if (component <= 0) {
      return withAlpha(currentZoneColor, 0.55);
    }
    return DISCONNECTED_ISLAND_FILLS[(component - 1) % DISCONNECTED_ISLAND_FILLS.length];
  }
}