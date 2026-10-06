import { Component, ElementRef, HostListener, OnDestroy, ViewChild, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CubeConstructorService } from '../../state/cube-constructor.service';
import { MeshShapeParametersDto } from '../../api/mesh-editor-api.service';
import { NodeDrag, roundedPosition } from '../../geometry/mesh-editor-drag';
import { MeshPick, MeshView, buildMeshView, disposeMeshView } from '../../geometry/mesh-editor-view';
import {
  CONSTRUCTOR_REGIONS,
  ConstructorRegion,
  REGION_LABELS,
  orthoCameraFor,
  perspectiveCameraFor,
  positionsBounds,
  regionAt,
  regionNdc,
  regionRects,
  shapeToState
} from '../../geometry/cube-constructor-view';

type Axis = 'x' | 'y' | 'z';

interface ParameterField {
  readonly key: keyof MeshShapeParametersDto;
  readonly label: string;
  readonly step: number;
  readonly min?: number;
}

const PARAMETER_FIELDS: readonly ParameterField[] = [
  { key: 'length', label: 'Довжина (X)', step: 0.1, min: 0.01 },
  { key: 'height', label: 'Висота (Y)', step: 0.1, min: 0.01 },
  { key: 'depth', label: 'Ширина (Z)', step: 0.1, min: 0.01 },
  { key: 'taper', label: 'Верх відносно низу', step: 0.05, min: 0.05 },
  { key: 'shearX', label: 'Зсув верху по X', step: 0.05 },
  { key: 'shearZ', label: 'Зсув верху по Z', step: 0.05 }
];

// Moving less than this many CSS pixels between press and release is a click, not a drag.
const CLICK_THRESHOLD_PX = 4;

// The cube constructor: one cube designed on its own in a full-screen window -
// front, side and top views where a node is dragged in the plane of the view,
// plus a free 3D view - with parameters, a library of shapes and a table of the 20
// nodes for exact numbers. What is designed here is only a draft (CubeConstructorService);
// "Додати на сцену" hands it to the backend, which fits it onto the picked face.
@Component({
  selector: 'app-cube-constructor',
  standalone: true,
  imports: [NgIf, NgFor],
  templateUrl: './cube-constructor.component.html',
  styleUrl: './cube-constructor.component.scss'
})
export class CubeConstructorComponent implements OnDestroy {
  readonly draft = inject(CubeConstructorService);
  readonly regions = CONSTRUCTOR_REGIONS;
  readonly regionLabels = REGION_LABELS;
  readonly parameterFields = PARAMETER_FIELDS;
  readonly axes: readonly Axis[] = ['x', 'y', 'z'];
  isTableOpen = false;

  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly scene = new THREE.Scene();
  private controls: OrbitControls | null = null;
  private perspective: THREE.PerspectiveCamera | null = null;
  private readonly orthos: Partial<Record<ConstructorRegion, THREE.OrthographicCamera>> = {};
  private view: MeshView | null = null;
  private drawnRevision = -1;
  private framedRevision = -1;
  private frameId = 0;
  private drag: NodeDrag | null = null;
  private press: { x: number; y: number; region: ConstructorRegion | null } | null = null;
  private lastRegion: ConstructorRegion | null = null;
  private listeners: Array<[string, (e: never) => void, boolean]> = [];

  // The canvas lives under *ngIf (it exists only while the window is open), so the
  // renderer is built when it appears and released when it goes: a closed window
  // holds no WebGL context.
  @ViewChild('canvas')
  set canvasRef(ref: ElementRef<HTMLCanvasElement> | undefined) {
    if (ref && ref.nativeElement !== this.canvas) {
      this.start(ref.nativeElement);
    } else if (!ref && this.canvas) {
      this.stop();
    }
  }

  ngOnDestroy(): void {
    this.stop();
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (!this.draft.isOpen() || event.key !== 'Escape' || (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'))) {
      return;
    }
    event.preventDefault();
    this.draft.close();
  }

  // --- the side panel ------------------------------------------------------------------

  validityText(): string {
    const check = this.draft.check;
    if (check === null) {
      return 'перевірка…';
    }
    if (check.error) {
      return check.error;
    }
    return check.valid ? `куб коректний (min det ${check.minDeterminant.toPrecision(3)})` : `куб вивернутий або вироджений (min det ${check.minDeterminant.toPrecision(3)})`;
  }

  isValid(): boolean | null {
    return this.draft.check === null ? null : this.draft.check.valid;
  }

  parameter(key: keyof MeshShapeParametersDto): number {
    return this.draft.parameters[key];
  }

  onParameter(key: keyof MeshShapeParametersDto, event: Event): void {
    this.draft.setParameter(key, Number((event.target as HTMLInputElement).value));
  }

  selectedKind(): string {
    const slot = this.draft.selectedSlot;
    return slot === null ? '' : slot < 8 ? 'кут' : 'середина ребра';
  }

  coordinate(slot: number, axis: Axis): number {
    return Math.round(this.draft.positions[slot][axis] * 1e6) / 1e6;
  }

  onCoordinate(slot: number, axis: Axis, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) {
      this.draft.setNodePosition(slot, { ...this.draft.positions[slot], [axis]: value });
    }
  }

  rows(): { slot: number; kind: string }[] {
    return this.draft.positions.map((_, slot) => ({ slot, kind: slot < 8 ? 'кут' : 'ребро' }));
  }

  canAdd(): boolean {
    return this.draft.target().kind !== 'none';
  }

  // --- drawing -------------------------------------------------------------------------

  private start(canvas: HTMLCanvasElement): void {
    this.stop();
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x1e1f22);
    this.renderer.setScissorTest(true);
    this.scene.add(new THREE.AxesHelper(0.6));
    this.perspective = perspectiveCameraFor(positionsBounds(this.draft.positions), 1);
    this.controls = new OrbitControls(this.perspective, canvas);
    this.controls.enableDamping = false;
    this.controls.enabled = false;
    this.framedRevision = -1;
    this.drawnRevision = -1;

    this.listen(canvas, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e), true);
    this.listen(canvas, 'pointermove', (e: PointerEvent) => this.onPointerMove(e), false);
    this.listen(canvas, 'pointerup', (e: PointerEvent) => this.onPointerUp(e), false);
    this.listen(canvas, 'pointercancel', (e: PointerEvent) => this.onPointerUp(e), false);
    this.listen(canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), true);
    this.frameId = requestAnimationFrame(this.animate);
  }

  private listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (e: never) => void, capture: boolean): void {
    target.addEventListener(type, handler as EventListener, capture);
    this.listeners.push([type, handler, capture]);
  }

  private stop(): void {
    cancelAnimationFrame(this.frameId);
    if (this.canvas) {
      for (const [type, handler, capture] of this.listeners) {
        this.canvas.removeEventListener(type, handler as EventListener, capture);
      }
    }
    this.listeners = [];
    if (this.view) {
      this.scene.remove(this.view.root);
      disposeMeshView(this.view);
      this.view = null;
    }
    this.scene.clear();
    this.controls?.dispose();
    this.controls = null;
    if (this.renderer) {
      this.renderer.dispose();
      // dispose() alone does not hand the context back; the canvas is thrown away with the window.
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
    this.canvas = null;
    this.drag = null;
    this.press = null;
  }

  private readonly animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    const renderer = this.renderer;
    const canvas = this.canvas;
    if (!renderer || !canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return;
    }
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (renderer.domElement.width !== Math.floor(width * renderer.getPixelRatio()) || renderer.domElement.height !== Math.floor(height * renderer.getPixelRatio())) {
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(width, height, false);
    }
    const rects = regionRects(width, height);
    this.syncDraft(rects, width, height);

    for (const region of CONSTRUCTOR_REGIONS) {
      const rect = rects[region];
      const camera = region === 'perspective' ? this.perspective! : this.orthos[region];
      if (!camera) {
        continue;
      }
      const glY = height - (rect.y + rect.height);
      renderer.setViewport(rect.x, glY, rect.width, rect.height);
      renderer.setScissor(rect.x, glY, rect.width, rect.height);
      renderer.render(this.scene, camera);
    }
  };

  // Rebuilds the drawing when the draft changed, and re-frames the cameras when a whole new shape
  // arrived (but not while a node is dragged - the view must not rescale under the pointer).
  private syncDraft(rects: ReturnType<typeof regionRects>, _width: number, _height: number): void {
    if (this.framedRevision !== this.draft.frameRevision) {
      this.framedRevision = this.draft.frameRevision;
      const bounds = positionsBounds(this.draft.positions);
      for (const region of ['front', 'side', 'top'] as const) {
        this.orthos[region] = orthoCameraFor(region, bounds, rects[region].width / rects[region].height);
      }
      this.perspective = perspectiveCameraFor(bounds, rects.perspective.width / rects.perspective.height);
      if (this.controls) {
        this.controls.object = this.perspective;
        this.controls.target.copy(bounds.isEmpty() ? new THREE.Vector3(0.5, 0.5, 0.5) : bounds.getCenter(new THREE.Vector3()));
        this.controls.update();
      }
    }
    for (const region of ['front', 'side', 'top'] as const) {
      const camera = this.orthos[region];
      const aspect = rects[region].width / rects[region].height;
      if (camera && Math.abs(camera.right / camera.top - aspect) > 1e-6) {
        const half = camera.top;
        camera.left = -half * aspect;
        camera.right = half * aspect;
        camera.updateProjectionMatrix();
      }
    }
    if (this.perspective && Math.abs(this.perspective.aspect - rects.perspective.width / rects.perspective.height) > 1e-6) {
      this.perspective.aspect = rects.perspective.width / rects.perspective.height;
      this.perspective.updateProjectionMatrix();
    }
    if (this.drawnRevision !== this.draft.revision) {
      this.drawnRevision = this.draft.revision;
      if (this.view) {
        this.scene.remove(this.view.root);
        disposeMeshView(this.view);
      }
      this.view = buildMeshView(shapeToState(this.draft.positions), 'real', { hexes: [], face: null, hoverFace: null, nodeId: this.draft.selectedSlot });
      this.scene.add(this.view.root);
    }
  }

  // --- the mouse ---------------------------------------------------------------------

  private pointer(event: PointerEvent): { x: number; y: number; region: ConstructorRegion | null; width: number; height: number } {
    const rect = this.canvas!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return { x, y, width: rect.width, height: rect.height, region: regionAt(rect.width, rect.height, x, y) };
  }

  private cameraOf(region: ConstructorRegion): THREE.Camera | undefined {
    return region === 'perspective' ? (this.perspective ?? undefined) : this.orthos[region];
  }

  // The node (of the cube's 20) under a pointer in a region, or null.
  private slotAt(region: ConstructorRegion, x: number, y: number, width: number, height: number): number | null {
    const camera = this.cameraOf(region);
    if (!camera || !this.view) {
      return null;
    }
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(regionNdc(regionRects(width, height)[region], x, y), camera);
    const hit = raycaster.intersectObjects(this.view.pickables, false)[0];
    const pick = hit?.object.userData['pick'] as MeshPick | undefined;
    return pick?.kind === 'node' ? pick.nodeId : null;
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.canvas || event.button !== 0) {
      return;
    }
    const p = this.pointer(event);
    this.press = { x: event.clientX, y: event.clientY, region: p.region };
    // Only the 3D view may orbit; the three flat views keep their framing.
    if (this.controls) {
      this.controls.enabled = p.region === 'perspective' && this.slotAt('perspective', p.x, p.y, p.width, p.height) === null;
    }
    if (p.region && p.region !== 'perspective') {
      const slot = this.slotAt(p.region, p.x, p.y, p.width, p.height);
      const camera = this.cameraOf(p.region);
      if (slot !== null && camera) {
        event.stopImmediatePropagation();
        event.preventDefault();
        this.canvas.setPointerCapture(event.pointerId);
        const position = this.draft.positions[slot];
        this.drag = new NodeDrag(slot, new THREE.Vector3(position.x, position.y, position.z), camera);
        this.draft.selectSlot(slot);
      }
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.canvas) {
      return;
    }
    const p = this.pointer(event);
    this.lastRegion = p.region;
    if (this.drag && p.region !== null) {
      const region = this.press?.region;
      if (region && region !== 'perspective') {
        const position = this.drag.positionFor(regionNdc(regionRects(p.width, p.height)[region], p.x, p.y), event.shiftKey);
        this.draft.setNodePosition(this.drag.nodeId, roundedPosition(position));
      }
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (p.region) {
      this.canvas.style.cursor = this.slotAt(p.region, p.x, p.y, p.width, p.height) !== null ? 'grab' : '';
    }
  }

  private onPointerUp(event: PointerEvent): void {
    const canvas = this.canvas;
    const press = this.press;
    this.press = null;
    if (this.drag && canvas) {
      this.drag = null;
      canvas.style.cursor = '';
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (!canvas || !press || event.type === 'pointercancel') {
      return;
    }
    // A click (not an orbit): pick the node under it, or clear the pick.
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= CLICK_THRESHOLD_PX && press.region) {
      const p = this.pointer(event);
      this.draft.selectSlot(this.slotAt(press.region, p.x, p.y, p.width, p.height));
    }
  }

  private onWheel(event: WheelEvent): void {
    if (!this.canvas || !this.controls) {
      return;
    }
    const p = this.pointer(event as unknown as PointerEvent);
    this.controls.enabled = p.region === 'perspective';
  }
}
