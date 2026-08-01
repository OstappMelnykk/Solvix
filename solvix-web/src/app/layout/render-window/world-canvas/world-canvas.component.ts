import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WorldRepresentation } from '../../../state/world-representation.service';
import { KeyedStore } from '../../../state/keyed-store';

const DEFAULT_CAMERA_POSITION: [number, number, number] = [3, 3, 3];

interface CameraState {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

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
  // which saved camera angle to restore.
  @Input({ required: true }) sessionId!: number;
  // Not owned by this world - comes from whichever session is currently
  // active, so it changes as sessions switch. The whole representation
  // (object to render + this World's own data about it), not just the
  // Object3D, so `data` is actually reachable here instead of getting
  // silently dropped one layer up.
  @Input({ required: true }) representation!: WorldRepresentation;
  // Whether this is the World tab currently selected for the active
  // session. Drives OrbitControls interactivity and whether this canvas
  // actually renders - the other 2 keep simulating but stay unrendered.
  @Input({ required: true }) active!: boolean;

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
  private cameraStateBySession = new KeyedStore<number, CameraState>();
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
    this.updateSession();
    this.renderer.render(this.scene, this.camera);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    const canvas = this.canvasRef.nativeElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
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

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    this.camera.position.set(...DEFAULT_CAMERA_POSITION);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05 / 3;

    this.updateModel();

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 5, 5);
    this.scene.add(directionalLight);
  }

  private updateModel(): void {
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

  private updateSession(): void {
    if (this.lastSessionId === this.sessionId) {
      return;
    }
    if (this.lastSessionId !== null) {
      this.cameraStateBySession.set(this.lastSessionId, {
        position: this.camera.position.clone(),
        target: this.controls.target.clone()
      });
    }
    this.lastSessionId = this.sessionId;

    const saved = this.cameraStateBySession.get(this.sessionId);
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