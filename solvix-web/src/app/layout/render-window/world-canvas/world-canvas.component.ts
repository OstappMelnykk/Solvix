import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild, inject } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { IDEAL_WORLD_INDEX } from '../../../config/app-settings';
import { WorldRepresentation } from '../../../state/world-representation.service';
import { WorldCameraMemoryService } from '../../../state/world-camera-memory.service';
import { ImportedReferenceStyle, ImportedReferenceDisplayService } from '../../../state/imported-reference-display.service';
import { ImportedReferenceRenderService } from '../../../state/imported-reference-render.service';
import { VoxelizationService } from '../../../state/voxelization.service';
import { getVoxelCellByInstanceId } from '../../../geometry/voxel-preview';
import { recenterAtOrigin } from '../../../geometry/recenter-object3d';
import { disposeDimensionLines } from '../../../geometry/dimension-lines';
import { disposeRulerPreview } from '../../../geometry/ruler-preview';

const DEFAULT_CAMERA_POSITION: [number, number, number] = [3, 3, 3];
const AXES_LENGTH = 50;
const GRID_SIZE = 50;
const GRID_DIVISIONS = 50;
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
  imports: [],
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
  // Voxel preview is deliberately NOT an @Input like the overlays above -
  // see updateVoxelPreview() for why (a disposal race that was a real,
  // confirmed crash for this specific resource).

  @ViewChild('canvas') private canvasRef!: ElementRef<HTMLCanvasElement>;

  private renderer!: THREE.WebGLRenderer;
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
  private readonly referenceRender = inject(ImportedReferenceRenderService);
  // Read directly (not via @Input) inside updateVoxelPreview() - see there
  // for why.
  private readonly voxelization = inject(VoxelizationService);
  private readonly importedReferenceDisplay = inject(ImportedReferenceDisplayService);
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
  private lastSessionId: number | null = null;
  private sceneReady = false;
  private frameId = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private onContextLost = (event: Event) => event.preventDefault();
  private onContextRestored = () => this.checkResize();
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

    const canvas = this.canvasRef.nativeElement;
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);

    this.animate();
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
    this.updateVoxelPreview();
    this.updateSession();
    this.renderer.render(this.scene, this.camera);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    const canvas = this.canvasRef.nativeElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.currentImportedReference) {
      this.disposeImportedReferenceClone(this.currentImportedReference);
    }
    this.controls?.dispose();
    this.rotateGizmo?.dispose();
    this.renderer?.dispose();
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

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05 / 3;
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

    this.updateModel();
    this.updateImportedReference();
    this.updateDimensionLines();
    this.updateRuler();
    this.updateVoxelPreview();

    // Lower ambient than before, plus a key/fill pair of directional lights
    // from opposite sides (instead of one) - a single light + strong ambient
    // washes out shading almost evenly across a solid surface, making its
    // facets/contours hard to read. Two lights of different strength from
    // different angles give every face a distinct brightness, so shape and
    // silhouette actually read at a glance.
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(5, 8, 5);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
    fillLight.position.set(-5, 2, -5);
    this.scene.add(fillLight);

    // Standard THREE.js axis colors: X red, Y green, Z blue - a fixed scene
    // fixture (not per-session/model), same lifetime as the lights above, so
    // it needs no cleanup/disposal logic of its own either.
    this.scene.add(new THREE.AxesHelper(AXES_LENGTH));

    // Floor grid on the XZ plane (Y=0) - same fixed-fixture lifetime as
    // AxesHelper above, purely a visual reference for scale/orientation.
    this.scene.add(new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS));
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
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
    }
    this.currentModel = object.clone();
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
    this.lastImportedReference = source;
    this.lastImportedReferenceStyleKey = styleKey;

    if (this.currentImportedReference) {
      this.rotateGizmo.detach();
      this.scene.remove(this.currentImportedReference);
      this.disposeImportedReferenceClone(this.currentImportedReference);
      this.currentImportedReference = null;
    }

    if (source === null) {
      return;
    }

    const clone = source.clone();
    // A visual guide for the imported reference, not the model being worked
    // on - override materials so it never gets mistaken for the actual
    // session model rendered in the same scene. 'solid' is a normal LIT
    // material (MeshStandardMaterial, DoubleSide) so the scene's existing
    // lights actually shade it and it reads as a real 3D shape - solid
    // triangle fill is cheap on the GPU regardless of triangle count
    // (ordinary rasterization). 'wireframe' draws every triangle edge every
    // frame instead - fine for a light import, but measurably tanks FPS
    // well past a few hundred thousand triangles, hence this being a user
    // choice (ImportedReferenceDisplayService) rather than the only option.
    const mode = style?.mode ?? 'solid';
    const color = style?.color ?? 0xffffff;
    const opacity = style?.opacity ?? 0.5;
    // flatShading (solid mode only) - each triangle gets its own face
    // normal instead of interpolating vertex normals, so adjacent facets at
    // different angles pick up visibly different shading under the
    // key/fill lights above. Without it, curved/faceted surfaces lit this
    // way can look like a single smooth blob with no readable contours.
    const material: THREE.Material =
      mode === 'wireframe'
        ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity })
        : new THREE.MeshStandardMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, flatShading: true, roughness: 0.6 });
    clone.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.material = material;
      }
    });
    this.currentImportedReference = clone;
    this.scene.add(clone);
    this.rotateGizmo.attach(clone);
    this.renderer.compile(this.scene, this.camera);
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
      this.worldIndex === IDEAL_WORLD_INDEX && this.sessionId !== null && this.importedReferenceDisplay.getStyle(this.sessionId).voxelPreviewVisible
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

  // Geometry is shared with the source object (ImportedGeometryService owns
  // and disposes it) - only the material is unique to this clone (created
  // above), so only that gets disposed here.
  private disposeImportedReferenceClone(clone: THREE.Object3D): void {
    clone.traverse(child => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    });
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

    // Flush the camera-angle change through immediately, and drop any
    // in-flight damping momentum from the session we just left - without
    // this, leftover velocity would keep nudging the newly-restored angle.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    this.checkResize();
    this.updateModel();
    this.updateImportedReference();
    this.updateDimensionLines();
    this.updateRuler();
    this.updateVoxelPreview();
    this.updateSession();
    this.updateSettleAnimation();

    // ImportedReferenceDisplayService.rotateGizmoVisible - the user's own
    // show/hide toggle for the rings, independent of whether a reference is
    // even attached (rotateGizmo.object stays undefined until one is).
    const gizmoWanted = (this.importedReferenceStyle?.rotateGizmoVisible ?? true) && this.rotateGizmo.object !== undefined;
    this.rotateGizmo.getHelper().visible = this.active && gizmoWanted;
    this.rotateGizmo.enabled = this.active && gizmoWanted;
    // Suppress orbiting while a ring is actively being dragged - otherwise
    // OrbitControls' own pointer handling fights the gizmo's for the same
    // mouse drag.
    this.controls.enabled = this.active && !this.rotateGizmo.dragging;
    this.controls.update();

    if (this.active) {
      this.renderer.render(this.scene, this.camera);
    }
  };

  private checkResize(): void {
    const { clientWidth: width, clientHeight: height } = this.canvasRef.nativeElement.parentElement!;
    if (width === 0 || height === 0) {
      return;
    }
    if (width === this.lastWidth && height === this.lastHeight) {
      return;
    }
    this.lastWidth = width;
    this.lastHeight = height;
    this.updateCameraFrustum(width, height);
    this.renderer.setSize(width, height);
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

    // Same "flush immediately, drop leftover damping momentum" reasoning as
    // updateSession's own camera-angle restore.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;

    if (this.sessionId !== null) {
      this.cameraMemory.set(this.sessionId, this.worldIndex, {
        position: this.camera.position.clone(),
        target: this.controls.target.clone()
      });
    }
  }
}
