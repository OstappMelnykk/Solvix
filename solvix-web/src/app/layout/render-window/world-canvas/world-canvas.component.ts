import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { IDEAL_WORLD_INDEX } from '../../../config/app-settings';
import { WorldRepresentation } from '../../../state/world-representation.service';
import { WorldCameraMemoryService } from '../../../state/world-camera-memory.service';
import { SharedModelService } from '../../../state/shared-model.service';
import { ImportedReferenceStyle, ImportedReferenceDisplayService } from '../../../state/imported-reference-display.service';
import { ImportedReferenceRenderService } from '../../../state/imported-reference-render.service';
import { SixViewOverlayService } from '../../../state/six-view-overlay.service';
import { ZonePaintingService } from '../../../state/zone-painting.service';
import { SurfaceZonePaintingService } from '../../../state/surface-zone-painting.service';
import { VoxelizationService } from '../../../state/voxelization.service';
import { getVoxelCellByInstanceId } from '../../../geometry/scene-objects/voxels';
import { recenterAtOrigin } from '../../../geometry/recenter-object3d';
import { disposeDimensionLines } from '../../../geometry/dimension-lines';
import { disposeRulerPreview } from '../../../geometry/ruler-preview';
import { disposeHoleHighlight, setHoleMarkersVisible, updateHoleHighlightResolution } from '../../../geometry/scene-objects/hole-highlight';
import { buildZoneOverlayGroup, disposeZoneOverlayGroup, setZoneOverlayOpacity } from '../../../geometry/scene-objects/zone-overlay';
import { buildSurfaceZoneOverlay, disposeSurfaceZoneOverlay } from '../../../geometry/scene-objects/surface-zone-overlay';
import { buildSceneLights } from '../../../geometry/scene-objects/scene-lights';
import { buildAxesHelper } from '../../../geometry/scene-objects/axes-helper';
import { buildFloorGrid, updateGridResolution } from '../../../geometry/scene-objects/floor-grid';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { buildImportedReferenceClone, disposeImportedReferenceClone } from '../../../geometry/scene-objects/imported-reference';
import { WeightedOitRenderer } from '../../../rendering/weighted-oit';

const DEFAULT_CAMERA_POSITION: [number, number, number] = [3, 3, 3];
const SETTLE_DURATION_MS = 180;
// Above this many CSS pixels of movement between pointerdown and pointerup,
// treat the gesture as an OrbitControls drag, not a click-to-select - the
// browser's native `click` event has no such threshold (it fires on
// mouseup at the same DOM target regardless of how far the pointer moved
// in between), so this is tracked by hand.
const VOXEL_CLICK_MOVE_THRESHOLD_PX = 4;
// Both cameras' starting point (initScene) and what resetCamera() below
// restores - a single shared constant so the two can never drift apart.
const DEFAULT_ORTHO_HALF_HEIGHT = 5;
const DEFAULT_ORBIT_TARGET: [number, number, number] = [0, 0, 0];

// One of exactly 3 instances for the whole app - one per World (Ideal/Real/
// Solver). Its Scene/Camera/Renderer/OrbitControls are NOT recreated per
// session - this is what keeps the app at a fixed 3 WebGL contexts total,
// no matter how many sessions are open. But the camera's ANGLE is still a
// per-session thing the user expects to get back: each session's view is
// saved/restored in `cameraStateBySession` as the active session changes,
// so switching sessions swaps both the model and the camera angle, without
// ever touching the underlying WebGL context.
@Component({
  selector: 'app-world-canvas',
  standalone: true,
  imports: [NgFor],
  templateUrl: './world-canvas.component.html',
  styleUrl: './world-canvas.component.scss'
})
export class WorldCanvasComponent implements AfterViewInit, OnChanges, OnDestroy {
  // Which session is currently active - drives both the model shown and
  // which saved camera angle to restore. null when no session is open at
  // all (the last one was just closed) - updateModel/updateSession simply
  // do nothing in that case, leaving whatever was last shown frozen (fine,
  // since the whole RenderWindowComponent is [hidden] in that state too).
  @Input({ required: true }) sessionId!: number | null;
  // Not owned by this world - comes from whichever session is currently
  // active, so it changes as sessions switch. The whole representation
  // (object to render + this World's own data about it), not just the
  // Object3D, so `data` is actually reachable here instead of getting
  // silently dropped one layer up. null alongside a null sessionId.
  @Input({ required: true }) representation!: WorldRepresentation | null;
  // Whether this is the World tab currently selected for the active
  // session. Drives OrbitControls interactivity and whether this canvas
  // actually renders - the other 2 keep simulating but stay unrendered.
  @Input({ required: true }) active!: boolean;
  // Which of the 3 fixed World slots this instance is - the key this
  // component uses into WorldCameraMemoryService, alongside sessionId, so
  // its saved camera angles don't collide with the other 2 Worlds'.
  @Input({ required: true }) worldIndex!: number;
  // The session's imported reference geometry (ImportedGeometryService), if
  // any - a visual guide only, not part of `representation`. Optional
  // (defaults to null) since it's not core to what a World renders.
  @Input() importedReference: THREE.Object3D | null = null;
  // How to draw `importedReference` (ImportedReferenceDisplayService) -
  // visibility itself is handled one layer up (RenderWindowComponent hands
  // down importedReference: null when hidden), this is purely mode/color/
  // opacity for whatever IS being shown.
  @Input() importedReferenceStyle: ImportedReferenceStyle | null = null;
  // Draftsman-style axis dimension lines matching importedReference
  // (ImportedReferenceRenderService) - a separate overlay, independently
  // toggleable (ImportedReferenceDisplayService.dimensionsVisible).
  @Input() dimensionLines: THREE.Object3D | null = null;
  // Green tick-mark ruler along the longest axis (ImportedReferenceRenderService,
  // geometry/ruler-preview.ts) - a separate overlay, independently
  // toggleable (ImportedReferenceDisplayService.rulerVisible).
  @Input() ruler: THREE.Object3D | null = null;
  // Bright highlight tubes on exactly the boundary edges a hole punches into
  // the surface (ImportedReferenceRenderService, geometry/scene-objects/hole-highlight.ts) -
  // a separate overlay, independently toggleable (ImportedReferenceDisplayService.holesVisible).
  @Input() holeHighlight: THREE.Object3D | null = null;
  // Voxel preview is deliberately NOT an @Input like the overlays above -
  // see updateVoxelPreview() for why (a disposal race that was a real,
  // confirmed crash for this specific resource).

  @ViewChild('canvas') private canvasRef!: ElementRef<HTMLCanvasElement>;

  // Bumped only when this canvas's WebGL context was lost and the browser
  // never restored it (checked once per frame in animate() via
  // renderer.getContext().isContextLost() - onContextLost/onContextRestored
  // below handle the case where the browser DOES restore it; this is the
  // fallback for when it doesn't, which the spec never guarantees). Forces
  // Angular to hand this canvas a genuinely fresh <canvas> DOM element via
  // the template's own *ngFor/trackBy - the same mechanism ZonePaintingComponent/
  // SixViewOverlayComponent/ZonePreviewComponent already use for their own
  // canvases, adapted here since this one is otherwise never conditionally
  // destroyed at all.
  private canvasGeneration = 0;
  // Set the first frame a lost context is noticed, cleared once
  // recoverFromLostContext actually runs - guards against re-bumping
  // canvasGeneration every single frame while waiting for Angular to
  // actually swap the element in.
  private recreatingCanvas = false;
  private lastAttemptedCanvas: HTMLCanvasElement | null = null;
  canvasKeys(): number[] {
    return [this.canvasGeneration];
  }
  trackGeneration = (_: number, gen: number): number => gen;

  private renderer!: THREE.WebGLRenderer;
  // Every actual draw of `scene` goes through this instead of calling
  // `this.renderer.render()` directly - see rendering/weighted-oit.ts for
  // why (stable transparency between the STL reference and the voxel fill,
  // regardless of camera angle). It falls back to a plain direct render on
  // its own when nothing in the scene is tagged for it, so this is safe to
  // use unconditionally rather than branching here.
  private oitRenderer!: WeightedOitRenderer;
  private scene!: THREE.Scene;
  // Both cameras exist for the lifetime of this component (never recreated
  // per toggle) - `camera` is whichever one is currently active, swapped by
  // toggleCameraMode(). Belongs to this World instance, not the session
  // (same category as the camera itself in the class doc comment above) -
  // switching modes affects this World's canvas for whoever's looking at
  // it, independent of which session is active.
  private perspectiveCamera!: THREE.PerspectiveCamera;
  private orthographicCamera!: THREE.OrthographicCamera;
  private camera!: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  // Tracked separately from `camera` itself (rather than derived by
  // comparing it against `orthographicCamera`) because both of those
  // fields stay `undefined` until initScene() runs inside ngAfterViewInit -
  // which fires mid-way through Angular's very FIRST change detection
  // pass. The template (getCameraMode(), read twice per cycle in dev mode)
  // would see `undefined === undefined` (true - "orthographic") on the
  // first read and two real, distinct camera objects (false -
  // "perspective") on dev mode's immediate re-check of the same values,
  // throwing NG0100 on every single page load. This field has a real
  // default from the moment the class is constructed, so both reads
  // always agree.
  private cameraMode: 'perspective' | 'orthographic' = 'perspective';
  // Half the world-space height the orthographic camera shows at zoom=1 -
  // recomputed whenever switching INTO orthographic (from the perspective
  // camera's current distance-to-target, so the switch doesn't visibly
  // jump), then only its aspect-dependent left/right get touched on resize.
  private orthoHalfHeight = DEFAULT_ORTHO_HALF_HEIGHT;
  private controls!: OrbitControls;
  // The rotate gizmo (3 draggable ring arcs, one per axis) shown on the
  // imported reference - Ideal-World-only in practice, since importedReference
  // is only ever non-null there (RenderWindowComponent). Attached/detached
  // to whichever clone is currently shown; only truly interactive
  // (`.enabled`) while this canvas is the active tab, same gating as
  // `controls` (OrbitControls) below.
  private rotateGizmo!: TransformControls;
  // Floor grid on the XZ plane - kept by reference (not just added and
  // forgotten, like AxesHelper) so its `visible` flag can be flipped from
  // the on-canvas toggle button below, independently per World.
  private gridHelper!: LineSegments2;
  // Mirrors gridHelper.visible for the template - a real default from
  // construction, same reasoning as `cameraMode` above: the template can
  // read isGridVisible() during Angular's very first change detection
  // pass, before ngAfterViewInit (and initScene, which creates gridHelper)
  // has even run, so reading gridHelper.visible directly there would throw.
  private gridVisible = true;
  // Backing state for the "Показати зони" toggle (see hasAnyZones/
  // toggleZonesOverlay/updateZoneOverlay) - whether the user WANTS to see
  // it, independent of whether it's currently allowed to show (at least one
  // zone exists). Rebuilt lazily in updateZoneOverlay whenever the session or
  // ZonePaintingService.zonesRevision(sessionId) has changed since the last
  // build (a per-zone color edit bumps this WITHOUT changing zones.length,
  // so revision - not length - is what this must key on), same identity-
  // cache reasoning as updateVoxelPreview above.
  private zonesOverlayWanted = false;
  private zoneOverlayGroup: THREE.Group | null = null;
  private zoneOverlaySessionId: number | null = null;
  private zoneOverlayRevision = -1;
  // Same "wanted vs. currently allowed" split as zonesOverlayWanted above,
  // for the "Показати зони на STL" toggle - the zone list interleaves STL
  // painting per zone now (no single "saved, frozen forever" moment), so
  // this rebuilds whenever getTriangleZones returns a DIFFERENT array
  // instance than last time (recomputeTriangleZones always creates a fresh
  // one - see SurfaceZonePaintingService's own comment), not just once per
  // session.
  private surfaceZonesOverlayWanted = false;
  private surfaceZoneOverlayGroup: THREE.Object3D | null = null;
  private surfaceZoneOverlaySessionId: number | null = null;
  private surfaceZoneOverlayTriangleZone: Int16Array | null = null;
  // Last shouldShow value updateSurfaceZoneOverlay computed - lets it touch
  // currentImportedReference.visible only right at a real transition, not
  // unconditionally on every one of its (every-World, every-frame) calls.
  private surfaceZoneOverlayShown = false;
  private readonly referenceRender = inject(ImportedReferenceRenderService);
  // Read directly (not via @Input) inside updateVoxelPreview() - see there
  // for why.
  private readonly voxelization = inject(VoxelizationService);
  private readonly surfaceZonePainting = inject(SurfaceZonePaintingService);
  private readonly importedReferenceDisplay = inject(ImportedReferenceDisplayService);
  private readonly sixViewOverlay = inject(SixViewOverlayService);
  private readonly zonePainting = inject(ZonePaintingService);
  private readonly cdr = inject(ChangeDetectorRef);
  // Eases the re-ground/re-center position fix-up over SETTLE_DURATION_MS
  // instead of snapping it instantly on drag end - see the 'dragging-changed'
  // listener below for why position can't just be corrected live during the
  // drag itself. Without this, releasing a ring visibly "pops" the object up
  // to the floor, which reads as a bug (looks like height is being added)
  // rather than the intended settle.
  private settleAnimation: { object: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; startTime: number } | null = null;
  // The model actually placed in this canvas's own Scene - a clone of
  // `model`, never `model` itself. The same source Object3D is shared by
  // all 3 WorldCanvasComponent (WorldRepresentationService currently hands
  // every World the same instance) - a scene-graph node can only belong to
  // one Scene at a time, so adding the original directly would silently
  // steal it away from whichever canvas last called scene.add(). Cloning
  // shares the underlying geometry/material (cheap) while giving each
  // canvas its own independent placement.
  private currentModel: THREE.Object3D | null = null;
  private lastModel: THREE.Object3D | null = null;
  // Mirrors `currentModel !== null` for the template's hasModel() - a real
  // default from construction, same NG0100 reasoning as `cameraMode` and
  // `gridVisible` above: ngAfterViewInit (which populates currentModel via
  // updateModel(), synchronously, if a session/model already exists at
  // startup) runs mid-way through Angular's very first change detection
  // pass, so reading `currentModel !== null` directly from the template
  // would flip between that pass and dev mode's immediate re-check of the
  // same values.
  private modelPresent = false;
  // Same clone-not-original reasoning as `currentModel`/`lastModel`, for the
  // imported reference overlay (also shared across all 3 canvases via
  // ImportedGeometryService).
  private currentImportedReference: THREE.Object3D | null = null;
  private lastImportedReference: THREE.Object3D | null = null;
  // Cheap string comparison key for importedReferenceStyle - needed
  // alongside lastImportedReference because the SAME geometry can need
  // rebuilding when only mode/color/opacity change (e.g. toggling
  // solid/wireframe on an already-shown import).
  private lastImportedReferenceStyleKey: string | null = null;
  // Geometry/materials here are owned by ImportedReferenceRenderService (a
  // freshly-built object per density/import change, cached there) - same
  // sharing model as currentModel/lastModel, so this clones on add but
  // never disposes on remove (only the service's own rebuild/prune does).
  private currentDimensionLines: THREE.Object3D | null = null;
  private lastDimensionLines: THREE.Object3D | null = null;
  // Same sharing model as currentDimensionLines/lastDimensionLines.
  private currentRuler: THREE.Object3D | null = null;
  private lastRuler: THREE.Object3D | null = null;
  // Same sharing model as currentDimensionLines/lastDimensionLines.
  private currentHoleHighlight: THREE.Object3D | null = null;
  private lastHoleHighlight: THREE.Object3D | null = null;
  // Same sharing model as currentDimensionLines/lastDimensionLines - owned
  // and disposed by VoxelizationService, not here.
  private currentVoxelPreview: THREE.Object3D | null = null;
  private lastVoxelPreview: THREE.Object3D | null = null;
  // Click-to-select a single voxel (see handlePointerDown/Up below) -
  // Ideal-World-only in practice, since currentVoxelPreview is only ever
  // non-null there. Reused across clicks (raycaster/pointer are just scratch
  // objects, no per-click allocation needed) rather than owned by
  // VoxelizationService - picking is a property of THIS canvas's camera/DOM
  // element, not of the voxelization result itself.
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private pointerDownClient: { x: number; y: number } | null = null;
  private readonly cameraMemory = inject(WorldCameraMemoryService);
  private readonly sharedModel = inject(SharedModelService);
  private lastSessionId: number | null = null;
  private sceneReady = false;
  private frameId = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  // Read once here (construction time) rather than a fixed sentinel like
  // lastWidth/lastHeight's 0 - checkResize below only needs to react to it
  // actually CHANGING (e.g. the browser window dragged to a monitor with a
  // different scale factor), not to treat the very first frame as a change
  // when initScene has already set the renderer up with this same value.
  private lastPixelRatio = window.devicePixelRatio;
  private onContextLost = (event: Event) => event.preventDefault();
  // checkResize() alone is a no-op whenever the canvas's own CSS size
  // hasn't changed (the common case for a context loss/restore, which
  // isn't triggered by any resize) - meaning it did nothing useful here
  // before, leaving this canvas showing nothing until the NEXT time
  // something else happened to force a render. Forces one directly instead
  // (same idiom as ngOnChanges' own immediate-repaint-on-activate), then
  // still runs checkResize() in case the size DID also change while lost.
  private onContextRestored = () => {
    this.checkResize();
    this.oitRenderer.render(this.scene, this.camera);
  };
  private onPointerDown = (event: PointerEvent) => {
    this.pointerDownClient = { x: event.clientX, y: event.clientY };
  };
  private onPointerUp = (event: PointerEvent) => this.handleVoxelPointerUp(event);
  // Right-click is repurposed as the "build" gesture (see
  // handleVoxelPointerUp) - the browser's own context menu has no purpose
  // over this 3D view and would otherwise pop up on every build click.
  private onContextMenu = (event: Event) => event.preventDefault();
  // Delete/Backspace removes whichever voxel is currently selected - the
  // other half of the Minecraft-style build feature. Listens on `window`,
  // not the canvas, since three.js canvases aren't focusable/focused by
  // default - a canvas-scoped listener would simply never fire.
  private onKeyDown = (event: KeyboardEvent) => this.handleVoxelDeleteKey(event);

  ngAfterViewInit(): void {
    this.initScene();
    this.sceneReady = true;
    // initScene() (via updateModel()) can flip modelPresent from its
    // construction-time default to true, mid-way through Angular's very
    // first change-detection pass over THIS component's own template -
    // exactly the NG0100 hazard the cameraMode/gridVisible doc comments
    // above describe, except here the value genuinely does need to change.
    // Forcing this component's own view to re-check RIGHT NOW (rather than
    // leaving it for dev mode's later checkNoChanges pass to catch as a
    // stale-vs-fresh mismatch) folds that change into the current cycle
    // instead of exposing it across two.
    this.cdr.detectChanges();

    this.attachCanvasListeners(this.canvasRef.nativeElement);
    // Window-scoped, not canvas-scoped (three.js canvases aren't focusable
    // by default - see onKeyDown's own comment) - bound exactly once here,
    // for this component's whole lifetime, unlike the canvas-scoped
    // listeners above which get reattached to a fresh element every time
    // recoverFromLostContext runs.
    window.addEventListener('keydown', this.onKeyDown);

    this.animate();
  }

  // Canvas-scoped listeners only (NOT the window-scoped keydown above) -
  // shared between the initial setup (ngAfterViewInit) and
  // recoverFromLostContext, which needs to rebind these same 5 to a
  // genuinely new <canvas> element after a permanently-lost context. No
  // explicit removal from the OLD canvas is needed in that second case -
  // it's already been destroyed by Angular (the *ngFor/trackBy swap) by the
  // time this runs, taking its listeners with it.
  private attachCanvasListeners(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Force an immediate repaint the moment this canvas becomes the active
    // one, instead of waiting up to one requestAnimationFrame tick - without
    // this, the browser can paint a stale frame (whatever this canvas last
    // rendered, possibly a different session/world) right after [hidden] is
    // removed, before our next scheduled frame catches up. That stale flash
    // is the flicker.
    if (!this.sceneReady || changes['active']?.currentValue !== true) {
      return;
    }
    this.updateModel();
    this.updateImportedReference();
    this.updateDimensionLines();
    this.updateRuler();
    this.updateHoleHighlight();
    this.updateVoxelPreview();
    this.updateSession();
    this.oitRenderer.render(this.scene, this.camera);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    // Whatever's actually in this.currentModel RIGHT NOW - not whatever
    // SharedModelService last handed out via `representation` - is the true
    // state at the moment this canvas dies (toolbar-icon switch destroys all
    // 3 WorldCanvasComponent instances via NgComponentOutlet - see
    // docs/FRONTEND_ARCHITECTURE.md's own tech-debt note). Committing it here
    // is what lets the next WorldCanvasComponent instance for this session
    // pick up exactly where this one left off instead of silently reverting
    // to whatever was last explicitly committed (or nothing at all).
    if (this.sessionId !== null && this.currentModel) {
      this.sharedModel.commit(this.sessionId, this.currentModel);
    }
    const canvas = this.canvasRef.nativeElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.currentImportedReference) {
      disposeImportedReferenceClone(this.currentImportedReference);
    }
    this.clearZoneOverlay();
    this.clearSurfaceZoneOverlay();
    this.controls?.dispose();
    this.rotateGizmo?.dispose();
    this.oitRenderer?.dispose();
    this.renderer?.dispose();
  }

  // Renderer/oitRenderer/controls/rotateGizmo construction - extracted out
  // of initScene() so recoverFromLostContext() below can rebuild exactly
  // this part on a fresh <canvas> without re-running the rest of initScene()
  // (scene/cameras/model/lights/grid, none of which need to change - a lost
  // WebGL context doesn't erase this.scene or anything in it, only whatever
  // was drawing it).
  private setupRenderer(canvas: HTMLCanvasElement, width: number, height: number): void {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.oitRenderer = new WeightedOitRenderer(this.renderer);
    this.oitRenderer.setSize(width, height);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // No inertia - the camera stops the instant the drag/scroll gesture
    // ends, rather than easing to a stop on its own afterward.
    this.controls.enableDamping = false;
    this.controls.rotateSpeed = 0.5;

    // Rotate mode draws exactly the 3 draggable ring arcs (X/Y/Z, plus a
    // 4th screen-space ring) the user asked for - dragging one spins the
    // attached object around that axis. Detached (invisible, per attach/
    // detach behavior) until updateImportedReference() has something to
    // attach it to.
    this.rotateGizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.rotateGizmo.setMode('rotate');
    // Snap dragging to 45deg increments (0/45/90/135/180/...) - built into
    // TransformControls itself (applied before the delta is committed to
    // the object, so it's exact, not a post-hoc round), makes it easy to
    // land on a square/clean orientation instead of fighting to eyeball it.
    this.rotateGizmo.setRotationSnap(THREE.MathUtils.degToRad(45));
    this.scene.add(this.rotateGizmo.getHelper());

    // Fires continuously while dragging a ring - keep the dimension-lines/
    // ruler overlays' ORIENTATION following live (cheap: just copies the
    // quaternion onto separate objects, doesn't feed back into the gizmo's
    // own drag state at all). Deliberately does NOT touch position/recenter
    // here: rotate mode's drag math tracks deltas from a reference frame
    // captured once at pointer-down, and mutating the attached object's
    // position mid-drag was corrupting that frame, causing severe jitter/
    // shaking. Position is only fixed up once, at drag end below.
    this.rotateGizmo.addEventListener('objectChange', () => {
      if (this.currentImportedReference) {
        this.syncOverlayQuaternion();
      }
    });

    // Fires once when a drag starts/ends.
    this.rotateGizmo.addEventListener('dragging-changed', event => {
      if (event.value) {
        // A new drag starting mid-settle (rare: clicking another ring right
        // after releasing one) - drop the old settle rather than fight it;
        // this drag's own end will reground from wherever it left off.
        this.settleAnimation = null;
        return;
      }
      if (!this.currentImportedReference || this.sessionId === null) {
        return;
      }
      // Compute the re-grounded/re-centered target position (rotation is
      // final now, its world-space bbox changes shape as it rotates) but
      // don't jump straight there - capture it, restore the pre-correction
      // position, and ease into it instead (animate() below). Persisting
      // the rotation (ImportedReferenceRenderService, so a later density
      // change etc. rebuilds at the SAME orientation) is deferred until the
      // settle finishes, so the service doesn't swap in an already-correct
      // clone mid-animation and cut it short.
      const from = this.currentImportedReference.position.clone();
      recenterAtOrigin(this.currentImportedReference);
      const to = this.currentImportedReference.position.clone();
      this.currentImportedReference.position.copy(from);
      this.syncOverlayTransform();
      this.settleAnimation = { object: this.currentImportedReference, from, to, startTime: performance.now() };
    });
  }

  // Fired from animate() once a permanently-lost context (never restored by
  // the browser) has forced Angular to hand this World a genuinely fresh
  // <canvas> element (see canvasGeneration's own comment). Rebuilds exactly
  // the renderer/oitRenderer/controls/rotateGizmo bundle on it - this.scene
  // and everything in it (model, imported reference, grid, lights, overlays)
  // is untouched, since none of that ever lived in the lost context itself.
  private recoverFromLostContext(canvas: HTMLCanvasElement): void {
    // Plain data, not the live objects themselves - same reasoning as the
    // lazy tools' own savedCameraStates (see [[project_webgl_context_architecture]]):
    // a fresh OrbitControls is constructed below regardless (it binds DOM
    // listeners at construction time, so the old instance can't just be
    // reattached to a new element), so whatever it should look like has to
    // be copied onto it afterward instead.
    const savedTarget = this.controls.target.clone();
    const savedEnabled = this.controls.enabled;
    const hadAttachedReference = this.currentImportedReference !== null;

    this.scene.remove(this.rotateGizmo.getHelper());
    this.controls.dispose();
    this.rotateGizmo.dispose();
    this.oitRenderer.dispose();
    this.renderer.dispose();

    const { clientWidth: width, clientHeight: height } = canvas.parentElement!;
    this.setupRenderer(canvas, width, height);
    this.attachCanvasListeners(canvas);

    this.controls.target.copy(savedTarget);
    this.controls.enabled = savedEnabled;
    this.controls.update();
    if (hadAttachedReference && this.currentImportedReference) {
      this.rotateGizmo.attach(this.currentImportedReference);
    }

    // Forces checkResize()'s own diff check to re-apply size/pixel ratio to
    // the freshly created renderer on the very next frame, exactly as if
    // the canvas had genuinely changed size (it didn't - only the renderer
    // under it did, and setupRenderer already sized it once here, but this
    // also re-syncs anything checkResize additionally does, e.g.
    // updateCameraFrustum, rather than duplicating that logic here too).
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.renderer.compile(this.scene, this.camera);
    this.oitRenderer.render(this.scene, this.camera);
  }

  private initScene(): void {
    const canvas = this.canvasRef.nativeElement;
    const { clientWidth: width, clientHeight: height } = canvas.parentElement!;
    this.lastWidth = width;
    this.lastHeight = height;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1e1f22);

    // far=100 clipped the model out of view once the user zoomed out enough
    // for OrbitControls' camera distance to exceed it - easy to hit once the
    // scene can hold arbitrarily large imported/scaled geometry. This makes
    // the near:far ratio 100000:1, which would ordinarily risk z-fighting
    // (depth-buffer precision is spread across the whole range) - logarithmicDepthBuffer
    // on the renderer below is what actually keeps that safe, not the specific numbers here.
    this.perspectiveCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 10000);
    this.perspectiveCamera.position.set(...DEFAULT_CAMERA_POSITION);
    // Frustum bounds are placeholders here - updateCameraFrustum() (called
    // below via checkResize's first pass, and again on every toggle/resize)
    // sets the real left/right/top/bottom from orthoHalfHeight + aspect.
    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
    this.orthographicCamera.position.set(...DEFAULT_CAMERA_POSITION);
    this.camera = this.perspectiveCamera;
    this.updateCameraFrustum(width, height);

    this.setupRenderer(canvas, width, height);

    this.updateModel();
    this.updateImportedReference();
    this.updateDimensionLines();
    this.updateRuler();
    this.updateHoleHighlight();
    this.updateVoxelPreview();

    // Each a fixed scene fixture (not per-session/model), same lifetime as
    // the whole component, so none of them needs cleanup/disposal logic of
    // its own - see their own files under geometry/scene-objects/ for why
    // each looks the way it does.
    this.scene.add(buildSceneLights());
    this.scene.add(buildAxesHelper());

    // Visibility is user-toggleable (see toggleGridVisible below), so this
    // stays visible by default and gets its own field instead of being
    // added anonymously like the lights/axes above.
    this.gridHelper = buildFloorGrid();
    this.gridHelper.visible = this.gridVisible;
    updateGridResolution(this.gridHelper, width, height);
    this.scene.add(this.gridHelper);
  }

  private updateModel(): void {
    if (this.representation === null) {
      return;
    }
    const object = this.representation.object;
    if (this.lastModel === object) {
      return;
    }
    this.lastModel = object;
    // Captures whatever the OUTGOING session actually had, right before it's
    // discarded below - this.lastSessionId still holds that session's id
    // here (updateSession(), which advances it to this.sessionId, always
    // runs AFTER updateModel() in both ngOnChanges and animate() - see
    // their own call order). Without this, switching sessions (not
    // destroying any canvas at all) would silently drop whatever was last
    // built in the session being switched away from, same gap ngOnDestroy's
    // own commit() call closes for an actual canvas teardown.
    if (this.currentModel && this.lastSessionId !== null) {
      this.sharedModel.commit(this.lastSessionId, this.currentModel);
    }
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
    }
    this.currentModel = object.clone();
    this.modelPresent = true;
    this.scene.add(this.currentModel);
    // Each session's model carries its own, freshly-created material - the
    // GPU has never compiled a shader for it before. Warm it up here, while
    // this World might still be hidden, so the compile doesn't happen
    // synchronously during the forced render in ngOnChanges (which is
    // exactly the moment this canvas becomes visible) and flash unshaded
    // (white) geometry for a frame.
    this.renderer.compile(this.scene, this.camera);
  }

  private updateImportedReference(): void {
    const source = this.importedReference;
    const style = this.importedReferenceStyle;
    const styleKey = style ? `${style.mode}|${style.color}|${style.opacity}` : null;
    if (this.lastImportedReference === source && this.lastImportedReferenceStyleKey === styleKey) {
      return;
    }
    // Only an actual geometry/transform change (new import, density/scale
    // change, or a committed rotation) should re-aim the camera below - a
    // style-only change (color/opacity/solid<->wireframe) rebuilds the same
    // shape at the same place, so recentering on it would be a no-op at
    // best and, mid-drag on some other control, a pointless target jump.
    const geometryChanged = this.lastImportedReference !== source;
    this.lastImportedReference = source;
    this.lastImportedReferenceStyleKey = styleKey;

    if (this.currentImportedReference) {
      this.rotateGizmo.detach();
      this.scene.remove(this.currentImportedReference);
      disposeImportedReferenceClone(this.currentImportedReference);
      this.currentImportedReference = null;
    }

    if (source === null) {
      return;
    }

    const clone = buildImportedReferenceClone(source, style);
    this.currentImportedReference = clone;
    this.scene.add(clone);
    this.rotateGizmo.attach(clone);
    this.renderer.compile(this.scene, this.camera);

    if (geometryChanged) {
      this.centerOrbitTargetOn(clone);
    }
  }

  // Re-aims OrbitControls at the reference's current world-space bounding-
  // box center, without moving the camera itself - called whenever a NEW
  // scaled/rotated clone lands (new import, density change, committed
  // rotation). recenterAtOrigin (ImportedReferenceRenderService) always
  // keeps the object's X/Z center at world 0 and its bottom grounded at
  // Y=0, so DEFAULT_ORBIT_TARGET (world origin) only ever matches the
  // object's true center by coincidence for a zero-height object - for
  // anything with real height, the center sits at Y=halfHeight, which
  // shifts every time density/rotation changes its extents. Computed from
  // the live world bbox (not analytically) so it stays correct regardless
  // of rotation.
  private centerOrbitTargetOn(object: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) {
      return;
    }
    this.controls.target.copy(box.getCenter(new THREE.Vector3()));
    this.controls.update();
  }

  // Eases the object into its final re-grounded/re-centered position after
  // a rotate-gizmo drag ends (see the 'dragging-changed' listener) instead
  // of snapping it there instantly. Once the ease completes, persists the
  // rotation (ImportedReferenceRenderService) - deferred until now so the
  // service's rebuild doesn't swap in an already-settled clone mid-animation.
  private updateSettleAnimation(): void {
    const settle = this.settleAnimation;
    if (!settle) {
      return;
    }
    // The clone being animated got swapped out from under us (e.g. a style/
    // density change rebuilt the reference while this was still easing) -
    // nothing sensible left to finish animating.
    if (settle.object !== this.currentImportedReference) {
      this.settleAnimation = null;
      return;
    }

    const t = Math.min(1, (performance.now() - settle.startTime) / SETTLE_DURATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    settle.object.position.lerpVectors(settle.from, settle.to, eased);
    this.syncOverlayTransform();

    if (t >= 1) {
      this.settleAnimation = null;
      if (this.sessionId !== null) {
        this.referenceRender.setRotation(this.sessionId, settle.object.quaternion);
      }
    }
  }

  // Live mid-drag tracking (see the 'objectChange' listener above) - only
  // the orientation changes while dragging (position is deliberately left
  // alone until drag end), so only the quaternion needs to follow.
  private syncOverlayQuaternion(): void {
    if (!this.currentImportedReference) {
      return;
    }
    this.currentDimensionLines?.quaternion.copy(this.currentImportedReference.quaternion);
    this.currentRuler?.quaternion.copy(this.currentImportedReference.quaternion);
    this.currentHoleHighlight?.quaternion.copy(this.currentImportedReference.quaternion);
  }

  // Keeps the dimension-lines/ruler overlays rigidly attached to the
  // imported reference once the rotate gizmo drag ends - both are built in
  // the SAME local, pivot-centered frame as the reference mesh
  // (ImportedReferenceRenderService), so copying its position+quaternion
  // onto them is enough; no geometry rebuild needed.
  private syncOverlayTransform(): void {
    if (!this.currentImportedReference) {
      return;
    }
    if (this.currentDimensionLines) {
      this.currentDimensionLines.position.copy(this.currentImportedReference.position);
      this.currentDimensionLines.quaternion.copy(this.currentImportedReference.quaternion);
    }
    if (this.currentRuler) {
      this.currentRuler.position.copy(this.currentImportedReference.position);
      this.currentRuler.quaternion.copy(this.currentImportedReference.quaternion);
    }
    if (this.currentHoleHighlight) {
      this.currentHoleHighlight.position.copy(this.currentImportedReference.position);
      this.currentHoleHighlight.quaternion.copy(this.currentImportedReference.quaternion);
    }
  }

  private updateDimensionLines(): void {
    const source = this.dimensionLines;
    if (this.lastDimensionLines === source) {
      return;
    }
    this.lastDimensionLines = source;

    if (this.currentDimensionLines) {
      this.scene.remove(this.currentDimensionLines);
      // Disposed HERE, not by ImportedReferenceRenderService the moment it
      // builds a replacement - geometry/material are shared by reference
      // with this clone (clone() doesn't deep-copy them), so disposing
      // any earlier risks a still-scheduled render-loop frame drawing this
      // exact clone with GPU buffers that were already freed. This is the
      // one place that's actually done rendering the outgoing object.
      disposeDimensionLines(this.currentDimensionLines);
      this.currentDimensionLines = null;
    }

    if (source === null) {
      return;
    }

    this.currentDimensionLines = source.clone();
    this.scene.add(this.currentDimensionLines);
    this.renderer.compile(this.scene, this.camera);
  }

  private updateRuler(): void {
    const source = this.ruler;
    if (this.lastRuler === source) {
      return;
    }
    this.lastRuler = source;

    if (this.currentRuler) {
      this.scene.remove(this.currentRuler);
      // See updateDimensionLines' comment - disposed here, not by
      // ImportedReferenceRenderService, for the same shared-geometry
      // race reasoning.
      disposeRulerPreview(this.currentRuler);
      this.currentRuler = null;
    }

    if (source === null) {
      return;
    }

    this.currentRuler = source.clone();
    this.scene.add(this.currentRuler);
    this.renderer.compile(this.scene, this.camera);
  }

  private updateHoleHighlight(): void {
    const source = this.holeHighlight;
    if (this.lastHoleHighlight === source) {
      return;
    }
    this.lastHoleHighlight = source;

    if (this.currentHoleHighlight) {
      this.scene.remove(this.currentHoleHighlight);
      // See updateDimensionLines' comment - disposed here, not by
      // ImportedReferenceRenderService, for the same shared-geometry
      // race reasoning.
      disposeHoleHighlight(this.currentHoleHighlight);
      this.currentHoleHighlight = null;
    }

    if (source === null) {
      return;
    }

    this.currentHoleHighlight = source.clone();
    // Freshly cloned, so its LineMaterial's resolution uniform starts at
    // whatever LineMaterial defaults to (not this canvas's actual size) -
    // checkResize() only re-sets it on an ACTUAL resize, which may not
    // happen for a while (or ever) after this clone lands, so it needs
    // this canvas's current size set explicitly right here too.
    updateHoleHighlightResolution(this.currentHoleHighlight, this.lastWidth, this.lastHeight);
    this.scene.add(this.currentHoleHighlight);
    this.renderer.compile(this.scene, this.camera);
  }

  // Reads VoxelizationService/ImportedReferenceDisplayService DIRECTLY
  // here, every frame - NOT via an @Input like the overlays above.
  // Regression: an @Input is only refreshed when Angular actually runs
  // change detection for this component, which is gated on its own
  // (rAF-coalesced) schedule - a SEPARATE clock from this component's own
  // `animate()` rAF loop. VoxelizationService disposes a superseded
  // preview SYNCHRONOUSLY (run()/clearResult()), and BatchedMesh.dispose()
  // leaves the object in a state that crashes renderer.render() if it's
  // drawn again (nulls internal texture refs onBeforeRender then
  // dereferences). If this component's own rAF fired before Angular's CD
  // caught up, `this.voxelPreview` (the @Input) would still hold the
  // now-disposed reference, and this method's own "nothing changed" guard
  // would skip removing it - `renderer.render()` right after would then
  // throw. Computing the value directly here, in the SAME synchronous
  // call as the removal/render decision, makes that race impossible: JS
  // is single-threaded, so whatever VoxelizationService disposed has
  // already fully happened by the time this next runs, no matter which
  // rAF queue got there first.
  private updateVoxelPreview(): void {
    const source =
      this.worldIndex === IDEAL_WORLD_INDEX &&
      this.sessionId !== null &&
      this.importedReferenceDisplay.getStyle(this.sessionId).voxelPreviewVisible &&
      // "Показати зони на STL" is meant to show ONLY the colored STL
      // surface (per the user's own request) - the coarse voxel cubes
      // sitting in roughly the same physical space would otherwise
      // visually compete with (and largely hide) that fine-grained result.
      !this.isSurfaceZonesOverlayVisible()
        ? this.voxelization.getVoxelPreview(this.sessionId)
        : null;
    if (this.lastVoxelPreview === source) {
      return;
    }
    this.lastVoxelPreview = source;

    // Removes from the scene WITHOUT disposing - VoxelizationService owns
    // disposal entirely (run()/clearResult()/pruneTo), since it's the only
    // thing that actually knows when an object is retired for good versus
    // just temporarily not the one to show (e.g. "Показати кубики" toggled
    // off keeps the object valid in the service's cache; this component
    // must not destroy it just because it stopped being asked to draw it).
    if (this.currentVoxelPreview) {
      this.scene.remove(this.currentVoxelPreview);
      this.currentVoxelPreview = null;
    }

    if (source === null) {
      return;
    }

    // Added directly, NOT cloned - already in world space (see
    // buildVoxelPreview's own doc comment), unlike dimensionLines/ruler
    // (whose clone() exists specifically to copy the reference's position/
    // quaternion onto a per-canvas copy) - and BatchedMesh (the fill's
    // renderer) can't support Object3D.clone() at all regardless.
    this.currentVoxelPreview = source;
    this.scene.add(this.currentVoxelPreview);
    this.renderer.compile(this.scene, this.camera);
  }

  // Left-click selects a single voxel (highlighted red); right-click is the
  // Minecraft-style build gesture - it adds a new voxel directly adjacent
  // to whichever face was clicked. Both raycast against the current
  // preview's BatchedMesh; only which service call the hit gets forwarded
  // to differs. Fires on pointerup, gated by a movement threshold against
  // the matching pointerdown (onPointerDown) so an OrbitControls
  // drag-to-orbit gesture (mouse moves a lot between down and up) never
  // gets misread as a click.
  private handleVoxelPointerUp(event: PointerEvent): void {
    const downClient = this.pointerDownClient;
    this.pointerDownClient = null;
    if (!downClient) {
      return;
    }
    const movedPx = Math.hypot(event.clientX - downClient.x, event.clientY - downClient.y);
    if (movedPx > VOXEL_CLICK_MOVE_THRESHOLD_PX) {
      return;
    }
    // 0 = left (select), 2 = right (build) - anything else (e.g. the middle
    // button, used for panning) is none of this component's business.
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    // Voxel selection/build only exists in the Ideal World
    // (currentVoxelPreview is only ever non-null there), only on the
    // currently-active canvas tab, never while the rotate gizmo is
    // mid-drag (its own click already means something else - releasing a
    // ring, not picking/building a voxel), and never for a session that's
    // since closed.
    if (this.worldIndex !== IDEAL_WORLD_INDEX || !this.active || this.sessionId === null || this.rotateGizmo.dragging) {
      return;
    }

    const preview = this.currentVoxelPreview;
    const batchedFill = preview?.children.find((child): child is THREE.BatchedMesh => child instanceof THREE.BatchedMesh);
    if (!batchedFill) {
      if (event.button === 0) {
        this.voxelization.selectVoxelInstance(this.sessionId, null);
      }
      return;
    }

    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hit = this.raycaster.intersectObject(batchedFill)[0];

    if (event.button === 0) {
      const instanceId = hit && hit.batchId !== undefined ? hit.batchId : null;
      this.voxelization.selectVoxelInstance(this.sessionId, instanceId);
      return;
    }

    // Right-click (build): missing a hit, its instance, its face, or the
    // cell that instance resolves to all mean there's nothing to build
    // onto here - silently do nothing, same as a select-click into empty
    // space finding nothing to select.
    if (!hit || hit.batchId === undefined || !hit.face || !preview) {
      return;
    }
    const cell = getVoxelCellByInstanceId(preview, hit.batchId);
    if (!cell) {
      return;
    }
    this.voxelization.addVoxelOnFace(this.sessionId, cell, hit.face.normal);
  }

  // The other half of the Minecraft-style build: Delete/Backspace removes
  // whichever voxel is currently selected (VoxelizationService owns both
  // the selection and the removal - this just forwards the keypress).
  private handleVoxelDeleteKey(event: KeyboardEvent): void {
    if (event.key !== 'Delete' && event.key !== 'Backspace') {
      return;
    }
    if (this.worldIndex !== IDEAL_WORLD_INDEX || !this.active || this.sessionId === null) {
      return;
    }
    // Don't hijack Delete/Backspace while the user is typing somewhere else
    // in the UI (a settings-panel input, for instance) - this listener is
    // on `window`, not scoped to the canvas, so it sees every keypress in
    // the app regardless of what currently has focus.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    event.preventDefault();
    this.voxelization.removeSelectedVoxel(this.sessionId);
  }

  // Gates the STL-reference visibility toggle button below (world-canvas.
  // component.html) to the one canvas the reference actually lives on - same
  // reasoning as RenderWindowComponent.getImportedReference's own
  // IDEAL_WORLD_INDEX check, just read from this component's own worldIndex
  // Input instead.
  isIdealWorldCanvas(): boolean {
    return this.worldIndex === IDEAL_WORLD_INDEX;
  }

  // Backing state for the on-canvas STL-reference visibility toggle -
  // mirrors the settings-panel's own "Показати" checkbox
  // (ImportedReferenceControlsComponent.isReferenceVisible/
  // onReferenceVisibleChange, both driving the same
  // ImportedReferenceDisplayService.visible flag), just reachable without
  // opening the panel. Unlike lowering opacity, unchecking this actually
  // drops the reference from the scene entirely (RenderWindowComponent.
  // getImportedReference returns null while !visible), so whatever it was
  // occluding becomes visible again rather than merely dimmed. Defaults to
  // "visible" outside the Ideal World / without a session, matching
  // ImportedReferenceDisplayService's own DEFAULT_STYLE - never actually
  // shown there (isIdealWorldCanvas gates the button itself).
  isImportedReferenceVisible(): boolean {
    if (this.worldIndex !== IDEAL_WORLD_INDEX || this.sessionId === null) {
      return true;
    }
    return this.importedReferenceDisplay.getStyle(this.sessionId).visible;
  }

  toggleImportedReferenceVisible(): void {
    if (this.worldIndex !== IDEAL_WORLD_INDEX || this.sessionId === null) {
      return;
    }
    const currentlyVisible = this.importedReferenceDisplay.getStyle(this.sessionId).visible;
    this.importedReferenceDisplay.setVisible(this.sessionId, !currentlyVisible);
  }

  // Backing text for the R2-violation overlay (world-canvas.component.html)
  // - null hides it. deletionViolationBySession is keyed only by sessionId,
  // not by World, so this is gated to the Ideal World the same way the
  // voxel-build feature itself is (see handleVoxelDeleteKey/
  // handleVoxelPointerUp above) - otherwise the Real/Solver World canvases
  // for the same session would show it too. Component sizes aren't
  // grammatically pluralized (same simplification the settings-panel's own
  // "N кубів" status line already makes) - "+"-joined so the split itself
  // is legible at a glance, not just the group count.
  getDeletionViolationMessage(): string | null {
    if (this.worldIndex !== IDEAL_WORLD_INDEX || this.sessionId === null) {
      return null;
    }
    const violation = this.voxelization.getDeletionViolation(this.sessionId);
    if (!violation) {
      return null;
    }
    if (violation.kind === 'last-cube') {
      return 'Видалення заборонено: це останній воксель - вокселізація не може бути порожньою';
    }
    return `Видалення заборонено: геометрія розпадеться на ${violation.componentSizes.length} частини (${violation.componentSizes.join(' + ')} кубів)`;
  }

  private updateSession(): void {
    if (this.sessionId === null || this.lastSessionId === this.sessionId) {
      return;
    }
    if (this.lastSessionId !== null) {
      this.cameraMemory.set(this.lastSessionId, this.worldIndex, {
        position: this.camera.position.clone(),
        target: this.controls.target.clone()
      });
    }
    this.lastSessionId = this.sessionId;

    const saved = this.cameraMemory.get(this.sessionId, this.worldIndex);
    if (saved) {
      this.camera.position.copy(saved.position);
      this.controls.target.copy(saved.target);
    } else {
      this.camera.position.set(...DEFAULT_CAMERA_POSITION);
      this.controls.target.set(...DEFAULT_ORBIT_TARGET);
    }

    this.controls.update();
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    // Every per-frame update below runs in a single try/catch, and the
    // render() call further down runs in its OWN, separate one - so a
    // throwing update (a stale/disposed reference reached mid-scene-graph,
    // some future regression, whatever) can't silently stop render() from
    // ever being called again. Without this, a single bad frame would
    // repeat-throw forever (same state, same error, every tick) while never
    // rendering again - and since WebGLRenderer defaults to NOT preserving
    // the drawing buffer, the browser is free to clear an un-rendered-to
    // canvas to blank on its own, which is exactly what "canvas goes white"
    // looks like from a stuck update, as opposed to an actual lost WebGL
    // context (handled separately by onContextLost/onContextRestored
    // above). This can't fix whatever the underlying bug is, but it keeps
    // THIS World's last good frame on screen (or later frames working
    // again, if the bad state was transient) instead of a dead canvas.
    // Checked fresh every frame (not cached) - onContextLost/onContextRestored
    // above handle the case where the browser DOES restore this canvas's
    // context on its own; this is what notices when it doesn't (never
    // guaranteed by spec). Small, accepted race: if the browser restores it
    // in the handful of frames between noticing this and Angular actually
    // swapping in the fresh <canvas> below, this still goes ahead and
    // recreates the renderer anyway (one avoidable but harmless extra
    // context) rather than trying to detect and cancel that in flight.
    if (this.renderer.getContext().isContextLost()) {
      const canvas = this.canvasRef.nativeElement;
      if (!this.recreatingCanvas) {
        this.recreatingCanvas = true;
        this.lastAttemptedCanvas = canvas;
        this.canvasGeneration++;
      } else if (canvas !== this.lastAttemptedCanvas) {
        this.recreatingCanvas = false;
        this.recoverFromLostContext(canvas);
      }
      return;
    }
    try {
      this.checkResize();
      this.updateModel();
      this.updateImportedReference();
      this.updateDimensionLines();
      this.updateRuler();
      this.updateHoleHighlight();
      this.updateVoxelPreview();
      this.updateZoneOverlay();
      this.updateSurfaceZoneOverlay();
      this.updateSession();
      this.updateSettleAnimation();

      // ImportedReferenceDisplayService.rotateGizmoVisible - the user's own
      // show/hide toggle for the rings, independent of whether a reference is
      // even attached (rotateGizmo.object stays undefined until one is).
      const gizmoWanted = (this.importedReferenceStyle?.rotateGizmoVisible ?? true) && this.rotateGizmo.object !== undefined;
      this.rotateGizmo.getHelper().visible = this.active && gizmoWanted;
      this.rotateGizmo.enabled = this.active && gizmoWanted;
      // ImportedReferenceDisplayService.holeMarkersVisible - independent of
      // whether the outline/fill are shown at all, so a user zoomed in to
      // actually inspect a hole can hide just the marker pin sitting on top
      // of it without losing the precise outline underneath.
      setHoleMarkersVisible(this.currentHoleHighlight, this.importedReferenceStyle?.holeMarkersVisible ?? true);
      // Suppress orbiting while a ring is actively being dragged - otherwise
      // OrbitControls' own pointer handling fights the gizmo's for the same
      // mouse drag.
      this.controls.enabled = this.active && !this.rotateGizmo.dragging;
      this.controls.update();
    } catch (error) {
      console.error(`[WorldCanvasComponent] world ${this.worldIndex}: per-frame update failed, skipping this tick`, error);
    }

    if (this.active) {
      try {
        this.oitRenderer.render(this.scene, this.camera);
      } catch (error) {
        console.error(`[WorldCanvasComponent] world ${this.worldIndex}: render() failed`, error);
      }
    }
  };

  private checkResize(): void {
    const { clientWidth: width, clientHeight: height } = this.canvasRef.nativeElement.parentElement!;
    if (width === 0 || height === 0) {
      return;
    }
    // window.devicePixelRatio is a per-MONITOR value, not per-window - it
    // can change without any CSS width/height change at all (dragging the
    // window to a display with a different scale factor), which the old
    // width/height-only check below would never notice, leaving the
    // renderer's internal drawing buffer sized for whichever monitor the
    // app happened to start on - the actual cause of the reported
    // pixelation on a bigger/different monitor.
    const pixelRatio = window.devicePixelRatio;
    if (width === this.lastWidth && height === this.lastHeight && pixelRatio === this.lastPixelRatio) {
      return;
    }
    this.lastWidth = width;
    this.lastHeight = height;
    this.lastPixelRatio = pixelRatio;
    this.updateCameraFrustum(width, height);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height);
    this.oitRenderer.setSize(width, height);
    // The floor grid's LineMaterial needs the CURRENT canvas size to
    // convert its pixel linewidth into the right screen-space quad extrusion
    // (see floor-grid.ts's own comment) - stale otherwise on any resize.
    updateGridResolution(this.gridHelper, width, height);
    // The hole highlight's own LineMaterial (geometry/scene-objects/
    // hole-highlight.ts) needs the current canvas size, whenever there is
    // one - stale otherwise on any resize.
    updateHoleHighlightResolution(this.currentHoleHighlight, width, height);
  }

  // Keeps BOTH cameras' frustums matching the canvas's current aspect ratio,
  // regardless of which one is active - so whichever camera toggleCameraMode()
  // switches TO next is already correctly sized, not just the one currently
  // in use.
  private updateCameraFrustum(width: number, height: number): void {
    const aspect = width / height;
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();

    const halfHeight = this.orthoHalfHeight;
    this.orthographicCamera.left = -halfHeight * aspect;
    this.orthographicCamera.right = halfHeight * aspect;
    this.orthographicCamera.top = halfHeight;
    this.orthographicCamera.bottom = -halfHeight;
    this.orthographicCamera.updateProjectionMatrix();
  }

  // Whichever camera is currently active - read by the template to label
  // the toggle button.
  getCameraMode(): 'perspective' | 'orthographic' {
    return this.cameraMode;
  }

  // Swaps the active camera, carrying position/orientation across so the
  // view doesn't jump - both OrbitControls.object and TransformControls.camera
  // are plain reassignable properties (the latter is a reactive `defineProperty`
  // that propagates the change to its own gizmo/plane internals), so neither
  // control needs to be recreated.
  toggleCameraMode(): void {
    if (this.getCameraMode() === 'perspective') {
      this.switchToOrthographic();
    } else {
      this.switchToPerspective();
    }
  }

  private switchToOrthographic(): void {
    const target = this.controls.target;
    const distance = Math.max(0.01, this.perspectiveCamera.position.distanceTo(target));
    const fovRad = THREE.MathUtils.degToRad(this.perspectiveCamera.fov);
    // Half the vertical extent visible at that distance under the
    // perspective camera's own FOV - matching it here is what keeps the
    // apparent size of the scene the same at the moment of the switch.
    this.orthoHalfHeight = distance * Math.tan(fovRad / 2);
    this.orthographicCamera.position.copy(this.perspectiveCamera.position);
    this.orthographicCamera.quaternion.copy(this.perspectiveCamera.quaternion);
    this.orthographicCamera.zoom = 1;
    this.updateCameraFrustum(this.lastWidth, this.lastHeight);
    this.setActiveCamera(this.orthographicCamera, 'orthographic');
  }

  private switchToPerspective(): void {
    const target = this.controls.target;
    const halfHeight = this.orthoHalfHeight / this.orthographicCamera.zoom;
    const fovRad = THREE.MathUtils.degToRad(this.perspectiveCamera.fov);
    const distance = halfHeight / Math.tan(fovRad / 2);
    const offset = this.orthographicCamera.position.clone().sub(target);
    // Degenerate only if the camera sits exactly on its own target (never
    // happens in practice - OrbitControls keeps them apart - but falling
    // back to the current view direction instead of a NaN-producing
    // normalize() keeps this safe regardless).
    const direction = offset.lengthSq() > 1e-8 ? offset.normalize() : new THREE.Vector3(0, 0, 1).applyQuaternion(this.orthographicCamera.quaternion);
    this.perspectiveCamera.position.copy(target).addScaledVector(direction, distance);
    this.perspectiveCamera.quaternion.copy(this.orthographicCamera.quaternion);
    this.setActiveCamera(this.perspectiveCamera, 'perspective');
  }

  private setActiveCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, mode: 'perspective' | 'orthographic'): void {
    this.camera = camera;
    this.cameraMode = mode;
    this.controls.object = camera;
    this.controls.update();
    this.rotateGizmo.camera = camera;
  }

  // Backing state + action for the on-canvas floor-grid visibility toggle
  // (world-canvas.component.html) - independent per World, since each of
  // the 3 canvases owns its own GridHelper instance (see initScene).
  isGridVisible(): boolean {
    return this.gridVisible;
  }

  toggleGridVisible(): void {
    this.gridVisible = !this.gridVisible;
    this.gridHelper.visible = this.gridVisible;
  }

  // Backing state + action for the on-canvas "6 сторін" button - opens the
  // single, app-wide SixViewOverlayComponent (app.component.html) showing
  // THIS World's current model. Disabled (via hasModel()) rather than a
  // no-op click, matching how the STL-visibility button doesn't appear at
  // all outside the Ideal World - here there's simply nothing to show.
  hasModel(): boolean {
    return this.modelPresent;
  }

  // Backing state + action for the on-canvas "Розмітка зон" button -
  // docs/local-refinement/PROBLEMS.md, Проблема 2, Варіант D. Gated to the
  // Ideal World (same reasoning as isImportedReferenceVisible - zoning is
  // about the shape itself, not a per-World display concern) AND to a
  // successful voxelization, since the tool paints over that grid's own
  // (ix,iy,iz) indices - there's nothing to paint before it exists.
  hasVoxelization(): boolean {
    return this.sessionId !== null && this.voxelization.getStatus(this.sessionId).kind === 'ok';
  }

  // Fixtures that are clutter, not content, in every fixed-axis "just show
  // me the model" preview this canvas can feed (SixViewOverlayComponent,
  // ZonePaintingComponent, and - via ZonePaintingSource.hiddenDuringView,
  // carried through by its own openStep2ForZone - SurfaceZonePaintingComponent
  // too): the floor grid, the interactive rotate-gizmo ring (meaningless
  // outside THIS canvas's own orbit controls), and the dimension-lines/ruler
  // measurement overlays (ImportedReferenceDisplayService's
  // dimensionsVisible/rulerVisible toggles) - all still visible on THIS
  // canvas's own normal view the whole time, just hidden for the duration
  // of each preview's own render() calls (see each component's own animate()).
  // A snapshot at whichever moment the preview is opened, same as
  // framingObjects/voxelPreview/stlMesh below - toggling dimension
  // lines/ruler ON only AFTER a preview is already open won't retroactively
  // hide them there until it's reopened, matching how this already worked
  // for gridHelper/the rotate gizmo.
  private previewFixtures(): THREE.Object3D[] {
    const fixtures: THREE.Object3D[] = [this.gridHelper, this.rotateGizmo.getHelper()];
    if (this.currentDimensionLines) {
      fixtures.push(this.currentDimensionLines);
    }
    if (this.currentRuler) {
      fixtures.push(this.currentRuler);
    }
    if (this.currentHoleHighlight) {
      fixtures.push(this.currentHoleHighlight);
    }
    return fixtures;
  }

  openZonePainting(): void {
    if (this.worldIndex === IDEAL_WORLD_INDEX && this.sessionId !== null && this.currentVoxelPreview) {
      this.zonePainting.open(this.sessionId, {
        scene: this.scene,
        voxelPreview: this.currentVoxelPreview,
        stlMesh: this.currentImportedReference,
        framingObjects: [this.currentVoxelPreview],
        hiddenDuringView: this.previewFixtures()
      });
    }
  }

  // Backing state + action for the on-canvas "Показати зони" button - shows
  // the same colored-zone overlay the zone-painting window's own 3D result
  // panel shows (geometry/zone-overlay.ts, shared code), but directly on
  // THIS canvas's normal, freely-orbitable view of the full-size model.
  // Enabled once at least one zone exists - the zone list no longer has a
  // single "fully covered and confirmed" moment (zones are committed one at
  // a time, partial coverage is an accepted end state, unclaimed voxels
  // fall back to the automatic check), so showing a partial result here is
  // no longer a sign of something unfinished, just the current state.
  hasAnyZones(): boolean {
    if (this.sessionId === null) {
      return false;
    }
    const coverage = this.zonePainting.coverage(this.sessionId);
    return coverage !== null && coverage.assigned > 0;
  }

  isZonesOverlayVisible(): boolean {
    return this.zonesOverlayWanted && this.hasAnyZones();
  }

  toggleZonesOverlay(): void {
    this.zonesOverlayWanted = !this.zonesOverlayWanted;
  }

  // Lazily (re)builds the overlay group only when the session or the zone
  // data itself has actually changed since the last build - called every
  // frame from animate(), same pattern as updateVoxelPreview.
  private updateZoneOverlay(): void {
    // "Показати зони на STL" means ONLY the STL surface's zones show - the
    // voxel color-box overlay would otherwise still float there
    // independently (it's a separate object, unaffected by
    // updateVoxelPreview hiding the plain voxel cubes on their own).
    const shouldShow = this.worldIndex === IDEAL_WORLD_INDEX && this.isZonesOverlayVisible() && !this.isSurfaceZonesOverlayVisible();
    if (!shouldShow) {
      this.clearZoneOverlay();
      return;
    }

    const sessionId = this.sessionId!;
    const session = this.zonePainting.getSession(sessionId);
    if (!session) {
      this.clearZoneOverlay();
      return;
    }
    const revision = this.zonePainting.zonesRevision(sessionId);
    if (this.zoneOverlayGroup && this.zoneOverlaySessionId === sessionId && this.zoneOverlayRevision === revision) {
      return; // already showing the current zone data - nothing to rebuild
    }

    if (this.zoneOverlayGroup) {
      disposeZoneOverlayGroup(this.zoneOverlayGroup);
      this.zoneOverlayGroup = null;
    }
    const opacity = this.zonePainting.getZoneOverlayOpacity(sessionId);
    const group = buildZoneOverlayGroup(session.grid, session.zones, (ix, iy, iz) => this.zonePainting.zoneIdAt(sessionId, ix, iy, iz), opacity);
    if (group) {
      this.scene.add(group);
    }
    this.zoneOverlayGroup = group;
    this.zoneOverlaySessionId = sessionId;
    this.zoneOverlayRevision = revision;
  }

  private clearZoneOverlay(): void {
    if (this.zoneOverlayGroup) {
      disposeZoneOverlayGroup(this.zoneOverlayGroup);
      this.zoneOverlayGroup = null;
    }
    this.zoneOverlaySessionId = null;
    this.zoneOverlayRevision = -1;
  }

  // Backing value + action for the "Прозорість зон" slider next to
  // "Показати зони" - cheap live update (setZoneOverlayOpacity just touches
  // each material's opacity), not a full updateZoneOverlay rebuild, so
  // dragging the slider stays smooth. Persisted per-session
  // (ZonePaintingService.setZoneOverlayOpacity) - the SAME value the
  // zone-painting window's own 3D result panel slider reads/writes, so
  // adjusting it in either place carries over to the other.
  zoneOverlayOpacity(): number {
    return this.sessionId === null ? 0.75 : this.zonePainting.getZoneOverlayOpacity(this.sessionId);
  }

  setZoneOverlayOpacityFromInput(value: string): void {
    if (this.sessionId === null) {
      return;
    }
    const opacity = Number(value);
    this.zonePainting.setZoneOverlayOpacity(this.sessionId, opacity);
    if (this.zoneOverlayGroup) {
      setZoneOverlayOpacity(this.zoneOverlayGroup, opacity);
    }
  }

  // Backing state + action for the "Показати зони на STL" button - the
  // step-2 (surface) counterpart to hasAnyZones/isZonesOverlayVisible/
  // toggleZonesOverlay above. Enabled once at least one zone has any STL
  // data at all, same "partial is a real end state" reasoning as the voxel
  // version.
  hasAnySurfaceZoning(): boolean {
    if (this.sessionId === null) {
      return false;
    }
    const coverage = this.surfaceZonePainting.coverage(this.sessionId);
    return coverage !== null && coverage.assigned > 0;
  }

  isSurfaceZonesOverlayVisible(): boolean {
    return this.surfaceZonesOverlayWanted && this.hasAnySurfaceZoning();
  }

  toggleSurfaceZonesOverlay(): void {
    this.surfaceZonesOverlayWanted = !this.surfaceZonesOverlayWanted;
  }

  // Lazily builds the overlay once per session (never rebuilt after that -
  // unlike updateZoneOverlay, step 2's data is frozen the moment save()
  // succeeds, so there's no revision to key off) - called every frame from
  // animate(), same pattern as updateZoneOverlay/updateVoxelPreview.
  private updateSurfaceZoneOverlay(): void {
    const shouldShow = this.worldIndex === IDEAL_WORLD_INDEX && this.isSurfaceZonesOverlayVisible();
    // The overlay is a fully-opaque clone of the EXACT same STL geometry,
    // at the exact same depth - leaving the original reference visible
    // underneath it would z-fight (2 coincident opaque surfaces, flickering
    // unpredictably by floating-point depth precision) rather than being
    // cleanly occluded. Toggled here (not inside updateImportedReference's
    // own rebuild logic) so flipping this on/off never triggers a pointless
    // reference rebuild/re-gizmo-attach cycle - same object, just hidden.
    //
    // Only touched right AT the shouldShow transition, not unconditionally
    // every frame: this runs for all 3 Worlds, every frame, regardless of
    // which one is actually active - forcing .visible=true every single
    // tick whenever shouldShow is false would fight any OTHER mechanism
    // that legitimately wants this object hidden for its own reasons
    // (its own visibility checkbox, a different overlay's own toggling)
    // by re-asserting an opinion here nobody asked for on ticks where
    // nothing actually changed.
    if (shouldShow !== this.surfaceZoneOverlayShown && this.currentImportedReference) {
      this.currentImportedReference.visible = !shouldShow;
    }
    this.surfaceZoneOverlayShown = shouldShow;
    if (!shouldShow) {
      this.clearSurfaceZoneOverlay();
      return;
    }

    const sessionId = this.sessionId!;
    const triangleZone = this.surfaceZonePainting.getTriangleZones(sessionId);
    if (this.surfaceZoneOverlayGroup && this.surfaceZoneOverlaySessionId === sessionId && this.surfaceZoneOverlayTriangleZone === triangleZone) {
      return; // already showing this exact triangleZone result - nothing to rebuild
    }
    if (this.surfaceZoneOverlayGroup) {
      disposeSurfaceZoneOverlay(this.surfaceZoneOverlayGroup);
      this.surfaceZoneOverlayGroup = null;
    }
    const session = this.surfaceZonePainting.getSession(sessionId);
    if (!session || !triangleZone || !this.currentImportedReference) {
      this.surfaceZoneOverlaySessionId = null;
      this.surfaceZoneOverlayTriangleZone = null;
      return;
    }
    const group = buildSurfaceZoneOverlay(this.currentImportedReference, triangleZone, session.voxelZones, 1);
    this.scene.add(group);
    this.surfaceZoneOverlayGroup = group;
    this.surfaceZoneOverlaySessionId = sessionId;
    this.surfaceZoneOverlayTriangleZone = triangleZone;
  }

  private clearSurfaceZoneOverlay(): void {
    if (this.surfaceZoneOverlayGroup) {
      disposeSurfaceZoneOverlay(this.surfaceZoneOverlayGroup);
      this.surfaceZoneOverlayGroup = null;
    }
    this.surfaceZoneOverlaySessionId = null;
    this.surfaceZoneOverlayTriangleZone = null;
  }

  openSixView(): void {
    if (this.currentModel && this.sessionId !== null) {
      const framingObjects: THREE.Object3D[] = [this.currentModel];
      if (this.currentImportedReference) {
        framingObjects.push(this.currentImportedReference);
      }
      this.sixViewOverlay.open({
        scene: this.scene,
        sessionId: this.sessionId,
        isIdealWorld: this.worldIndex === IDEAL_WORLD_INDEX,
        framingObjects,
        // AxesHelper stays (not part of previewFixtures) - orientation is
        // exactly what these 6 fixed-axis panels are about.
        hiddenDuringView: this.previewFixtures()
      });
    }
  }

  // Restores this World's camera to exactly what it was right after
  // initScene() - position, orbit target, perspective mode, and the
  // orthographic camera's zoom/frustum - undoing any orbiting, panning,
  // zooming, or mode switching the user has done since. Also persists that
  // as this session's saved angle (WorldCameraMemoryService), same as
  // updateSession does on every session switch - without this, switching
  // away and back would bring the OLD (pre-reset) angle back.
  resetCamera(): void {
    this.perspectiveCamera.position.set(...DEFAULT_CAMERA_POSITION);
    this.orthographicCamera.position.set(...DEFAULT_CAMERA_POSITION);
    this.orthographicCamera.zoom = 1;
    this.orthoHalfHeight = DEFAULT_ORTHO_HALF_HEIGHT;
    this.updateCameraFrustum(this.lastWidth, this.lastHeight);
    this.controls.target.set(...DEFAULT_ORBIT_TARGET);

    if (this.cameraMode !== 'perspective') {
      this.setActiveCamera(this.perspectiveCamera, 'perspective');
    }

    this.controls.update();

    if (this.sessionId !== null) {
      this.cameraMemory.set(this.sessionId, this.worldIndex, {
        position: this.camera.position.clone(),
        target: this.controls.target.clone()
      });
    }
  }
}
