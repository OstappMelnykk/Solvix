import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild, inject } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WorldRepresentation } from '../../../state/world-representation.service';
import { WorldCameraMemoryService } from '../../../state/world-camera-memory.service';
import { ImportedReferenceStyle } from '../../../state/imported-reference-display.service';

const DEFAULT_CAMERA_POSITION: [number, number, number] = [3, 3, 3];
const AXES_LENGTH = 50;

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
  // (ImportedReferenceScaleService) - a separate overlay, independently
  // toggleable (ImportedReferenceDisplayService.dimensionsVisible).
  @Input() dimensionLines: THREE.Object3D | null = null;
  // Green tick-mark ruler along the longest axis (ImportedReferenceScaleService,
  // geometry/ruler-preview.ts) - a separate overlay, independently
  // toggleable (ImportedReferenceDisplayService.rulerVisible).
  @Input() ruler: THREE.Object3D | null = null;

  @ViewChild('canvas') private canvasRef!: ElementRef<HTMLCanvasElement>;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
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
  // Geometry/materials here are owned by ImportedReferenceScaleService (a
  // freshly-built object per density/import change, cached there) - same
  // sharing model as currentModel/lastModel, so this clones on add but
  // never disposes on remove (only the service's own rebuild/prune does).
  private currentDimensionLines: THREE.Object3D | null = null;
  private lastDimensionLines: THREE.Object3D | null = null;
  // Same sharing model as currentDimensionLines/lastDimensionLines.
  private currentRuler: THREE.Object3D | null = null;
  private lastRuler: THREE.Object3D | null = null;
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
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 10000);
    this.camera.position.set(...DEFAULT_CAMERA_POSITION);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05 / 3;

    this.updateModel();
    this.updateImportedReference();
    this.updateDimensionLines();
    this.updateRuler();

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 5, 5);
    this.scene.add(directionalLight);

    // Standard THREE.js axis colors: X red, Y green, Z blue - a fixed scene
    // fixture (not per-session/model), same lifetime as the lights above, so
    // it needs no cleanup/disposal logic of its own either.
    this.scene.add(new THREE.AxesHelper(AXES_LENGTH));
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
    const color = style?.color ?? 0x39c5f2;
    const opacity = style?.opacity ?? 0.5;
    const material: THREE.Material =
      mode === 'wireframe'
        ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity })
        : new THREE.MeshStandardMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide });
    clone.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.material = material;
      }
    });
    this.currentImportedReference = clone;
    this.scene.add(clone);
    this.renderer.compile(this.scene, this.camera);
  }

  private updateDimensionLines(): void {
    const source = this.dimensionLines;
    if (this.lastDimensionLines === source) {
      return;
    }
    this.lastDimensionLines = source;

    if (this.currentDimensionLines) {
      this.scene.remove(this.currentDimensionLines);
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
      this.currentRuler = null;
    }

    if (source === null) {
      return;
    }

    this.currentRuler = source.clone();
    this.scene.add(this.currentRuler);
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
    this.updateSession();

    this.controls.enabled = this.active;
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
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}
