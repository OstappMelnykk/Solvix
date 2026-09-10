import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild, inject } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { WorldRepresentation } from '../../../state/world-representation.service';
import { WorldCameraMemoryService } from '../../../state/world-camera-memory.service';
import { ImportedReferenceStyle } from '../../../state/imported-reference-display.service';
import { ImportedReferenceRenderService } from '../../../state/imported-reference-render.service';
import { recenterAtOrigin } from '../../../geometry/recenter-object3d';
import { disposeDimensionLines } from '../../../geometry/dimension-lines';
import { disposeRulerPreview } from '../../../geometry/ruler-preview';

const DEFAULT_CAMERA_POSITION: [number, number, number] = [3, 3, 3];
const AXES_LENGTH = 50;
const GRID_SIZE = 50;
const GRID_DIVISIONS = 50;
const SETTLE_DURATION_MS = 180;

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
  // Instanced-cube preview of the last successful voxelization
  // (VoxelizationService, geometry/voxel-preview.ts) - unlike
  // importedReference/dimensionLines/ruler, already built in WORLD space
  // (see buildVoxelPreview's doc comment), so it's added to the scene at
  // identity rather than needing a position/quaternion copied onto it.
  @Input() voxelPreview: THREE.Object3D | null = null;

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
  // Half the world-space height the orthographic camera shows at zoom=1 -
  // recomputed whenever switching INTO orthographic (from the perspective
  // camera's current distance-to-target, so the switch doesn't visibly
  // jump), then only its aspect-dependent left/right get touched on resize.
  private orthoHalfHeight = 5;
  private controls!: OrbitControls;
  // The rotate gizmo (3 draggable ring arcs, one per axis) shown on the
  // imported reference - Ideal-World-only in practice, since importedReference
  // is only ever non-null there (RenderWindowComponent). Attached/detached
  // to whichever clone is currently shown; only truly interactive
  // (`.enabled`) while this canvas is the active tab, same gating as
  // `controls` (OrbitControls) below.
  private rotateGizmo!: TransformControls;
  private readonly referenceRender = inject(ImportedReferenceRenderService);
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
  private readonly cameraMemory = inject(WorldCameraMemoryService);
  private lastSessionId: number | null = null;
  private sceneReady = false;
  private frameId = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private onContextLost = (event: Event) => event.preventDefault();
  private onContextRestored = () => this.checkResize();

  ngAfterViewInit(): void {
    this.initScene();
    this.sceneReady = true;

    const canvas = this.canvasRef.nativeElement;
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

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

  private updateVoxelPreview(): void {
    const source = this.voxelPreview;
    if (this.lastVoxelPreview === source) {
      return;
    }
    this.lastVoxelPreview = source;

    // Removes from the scene WITHOUT disposing, unlike dimensionLines/
    // ruler/importedReference above - see VoxelizationService.run for why
    // disposal now lives entirely there instead. This matters concretely
    // for the "Показати кубики" visibility toggle: that's a transition to
    // `source === null` (render-window.component.ts's getVoxelPreview)
    // while VoxelizationService's cache still holds this EXACT object
    // (voxelPreview isn't cloned per canvas - BatchedMesh can't support
    // Object3D.clone() at all, its constructor requires a maxInstanceCount
    // with no default) - disposing here on every removal used to destroy
    // that still-valid, still-cached object the instant it was hidden,
    // silently breaking it (BatchedMesh.dispose() is one-way) for good the
    // next time it was shown again.
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
    // quaternion onto a per-canvas copy).
    this.currentVoxelPreview = source;
    this.scene.add(this.currentVoxelPreview);
    this.renderer.compile(this.scene, this.camera);
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
      this.controls.target.set(0, 0, 0);
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
    return this.camera === this.orthographicCamera ? 'orthographic' : 'perspective';
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
    this.setActiveCamera(this.orthographicCamera);
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
    this.setActiveCamera(this.perspectiveCamera);
  }

  private setActiveCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    this.camera = camera;
    this.controls.object = camera;
    this.controls.update();
    this.rotateGizmo.camera = camera;
  }
}
