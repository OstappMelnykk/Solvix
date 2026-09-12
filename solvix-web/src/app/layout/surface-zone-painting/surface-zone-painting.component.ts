import { AfterViewInit, Component, ElementRef, OnDestroy, QueryList, ViewChildren, inject, signal } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Axis,
  AXES,
  axisCoords,
  projectedCoords
} from '../../state/zone-painting.service';
import { SurfaceZoneCellState, SurfaceZonePaintingService } from '../../state/surface-zone-painting.service';
import { worldPointToShellCell } from '../../geometry/surface-shell-grid';
import { voxelCenter } from '../../geometry/voxel-grid-contract';
import {
  buildSurfaceZoneOverlay,
  disposeSurfaceZoneOverlay,
  setSurfaceZoneOverlayOpacity
} from '../../geometry/scene-objects/surface-zone-overlay';
import { darkenZoneColorCss } from '../../geometry/scene-objects/zone-overlay';

type AxisSign = 1 | -1;

const AVAILABLE_FILL = 'rgba(180, 185, 190, 0.35)';
const EXCLUDED_FILL = 'rgba(10, 10, 12, 0.55)';
const PENDING_FILL = 'rgba(255, 255, 255, 0.55)';
const DEFAULT_OVERLAY_OPACITY = 0.75;

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

function upFor(axis: Axis, sign: AxisSign): THREE.Vector3 {
  return axis === 'y' ? new THREE.Vector3(0, 0, -sign) : new THREE.Vector3(0, 1, 0);
}

// The second step of Проблема 2 Варіант D (see SurfaceZonePaintingService's
// own header comment) - opens only once the voxel zoning is saved, and
// paints the SAME 3-axis mask mechanism directly onto a finer grid built
// from the STL surface, tying each committed selection to one of the
// already-decided voxel zones (picked explicitly, not by creation order -
// see the service's file header for why).
@Component({
  selector: 'app-surface-zone-painting',
  standalone: true,
  imports: [NgFor, NgIf],
  host: { '[hidden]': 'isHidden()' },
  templateUrl: './surface-zone-painting.component.html',
  styleUrl: './surface-zone-painting.component.scss'
})
export class SurfaceZonePaintingComponent implements AfterViewInit, OnDestroy {
  @ViewChildren('canvas') private canvasRefs!: QueryList<ElementRef<HTMLCanvasElement>>;
  @ViewChildren('overlay') private overlayRefs!: QueryList<ElementRef<HTMLCanvasElement>>;

  private readonly surfaceZonePainting = inject(SurfaceZonePaintingService);

  readonly axes = AXES;
  readonly panelIndices = Array.from({ length: PANEL_COUNT }, (_, i) => i);
  readonly message = signal<string | null>(null);

  private panelSign: Record<Axis, AxisSign> = { x: 1, y: 1, z: 1 };
  private viewStateCache: Partial<Record<Axis, { width: number; height: number; cells: SurfaceZoneCellState[] }>> = {};

  private renderers: THREE.WebGLRenderer[] = [];
  private cameras: THREE.OrthographicCamera[] = [];
  private controls: OrbitControls[] = [];
  private cameraHalfHeights: number[] = new Array(PANEL_COUNT).fill(1);
  private readonly lastPanelSizes: { width: number; height: number }[] = Array.from({ length: PANEL_COUNT }, () => ({ width: 0, height: 0 }));
  private readonly framingCenter = new THREE.Vector3();
  private framingRadius = 1;
  private lastSessionId: number | null = null;
  private frameId = 0;
  private viewReady = false;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private dragPanelIndex: number | null = null;
  private dragDownClient: { x: number; y: number } | null = null;
  private dragStart: { u: number; v: number } | null = null;
  private dragCurrent: { u: number; v: number } | null = null;

  // The colored result overlay - rebuilt once, right after save() succeeds
  // (SurfaceZonePaintingService.save's triangleZone result never changes
  // afterward), kept hidden except during the result panel's own render()
  // call, same idiom as ZonePaintingComponent's own zoneOverlayGroup.
  private resultOverlay: THREE.Object3D | null = null;

  ngAfterViewInit(): void {
    const canvases = this.canvasRefs.toArray().map(ref => ref.nativeElement);
    this.renderers = canvases.map(canvas => new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true }));
    this.cameras = canvases.map(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000));
    this.controls = this.cameras.map((camera, i) => {
      const controls = new OrbitControls(camera, canvases[i]);
      controls.screenSpacePanning = true;
      controls.enableDamping = false;
      if (i === RESULT_PANEL_INDEX) {
        controls.enableRotate = true;
      } else {
        controls.enableRotate = false;
        controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      }
      controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      return controls;
    });
    this.viewReady = true;
    this.animate();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.controls.forEach(controls => controls.dispose());
    this.renderers.forEach(renderer => renderer.dispose());
    this.disposeResultOverlay();
  }

  isHidden(): boolean {
    return this.surfaceZonePainting.activeSessionId() === null;
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
    this.applyFraming(index);
  }

  close(): void {
    this.surfaceZonePainting.close();
  }

  voxelZones(): { readonly voxelZoneId: number; readonly color: string }[] {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null) {
      return [];
    }
    return [...(this.surfaceZonePainting.getSession(sessionId)?.voxelZones ?? [])];
  }

  activeVoxelZoneId(): number | null {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    return sessionId === null ? null : this.surfaceZonePainting.getActiveVoxelZoneId(sessionId);
  }

  setActiveVoxelZoneId(voxelZoneId: number): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    this.surfaceZonePainting.setActiveVoxelZoneId(sessionId, voxelZoneId);
  }

  coverageText(): string {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.surfaceZonePainting.coverage(sessionId);
    return coverage ? `Розмічено: ${coverage.assigned} / ${coverage.total} ділянок сітки` : '';
  }

  finishSelection(): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const assigned = this.surfaceZonePainting.finishSelection(sessionId);
    this.refreshClassifications();
    if (assigned === 0) {
      this.message.set('Перетин 3 областей порожній - жодної ділянки не додано.');
    } else {
      this.message.set(`Додано ${assigned} ділянок до обраної зони.`);
    }
  }

  canSave(): boolean {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null || this.isSaved()) {
      return false;
    }
    const coverage = this.surfaceZonePainting.coverage(sessionId);
    return (
      coverage !== null &&
      coverage.total > 0 &&
      coverage.assigned >= coverage.total &&
      this.surfaceZonePainting.allVoxelZonesUsed(sessionId)
    );
  }

  isSaved(): boolean {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    return sessionId !== null && this.surfaceZonePainting.isSaved(sessionId);
  }

  save(): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const source = this.surfaceZonePainting.activeSource();
    if (sessionId === null || !source) {
      return;
    }
    if (this.surfaceZonePainting.save(sessionId, source.stlMesh)) {
      this.message.set('Розмітку STL збережено.');
      this.rebuildResultOverlay();
    }
  }

  resetSelections(): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    if (!window.confirm('Скинути всю розмітку STL-поверхні? Це незворотно.')) {
      return;
    }
    this.surfaceZonePainting.resetSelections(sessionId);
    this.message.set(null);
    this.refreshClassifications();
    this.disposeResultOverlay();
  }

  onPointerDown(index: number, event: PointerEvent): void {
    if (index === RESULT_PANEL_INDEX) {
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
    const sessionId = this.surfaceZonePainting.activeSessionId();

    if (this.dragPanelIndex === index && sessionId !== null && this.dragStart && this.dragCurrent && downClient) {
      const axis = this.axes[index];
      const { u: u0, v: v0 } = this.dragStart;
      const { u: u1, v: v1 } = this.dragCurrent;
      const ok =
        u0 === u1 && v0 === v1
          ? this.surfaceZonePainting.toggleCell(sessionId, axis, u0, v0)
          : this.surfaceZonePainting.selectRect(sessionId, axis, u0, v0, u1, v1);
      if (!ok) {
        this.message.set('Нічого не змінено - ділянки вже зайняті іншою зоною, недоступні, або дія розірвала б область на 2+ частини.');
      }
      this.refreshClassifications();
    }
    this.dragPanelIndex = null;
    this.dragStart = null;
    this.dragCurrent = null;
  }

  // Raycasts against the REAL STL mesh geometry directly (unlike the voxel
  // tool's BatchedMesh instance-id lookup) - a hit's own world-space point
  // is all worldPointToShellCell needs.
  private raycastCell(index: number, event: PointerEvent): { ix: number; iy: number; iz: number } | null {
    const source = this.surfaceZonePainting.activeSource();
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const canvas = this.canvasRefs.get(index)?.nativeElement;
    if (!source || sessionId === null || !canvas) {
      return null;
    }
    const grid = this.surfaceZonePainting.getSession(sessionId)?.grid;
    if (!grid) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.cameras[index]);
    const hit = this.raycaster.intersectObject(source.stlMesh, true)[0];
    if (!hit) {
      return null;
    }
    return worldPointToShellCell(grid, hit.point);
  }

  private refreshClassifications(): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    for (const axis of AXES) {
      this.viewStateCache[axis] = this.surfaceZonePainting.viewState(sessionId, axis);
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
    const radius = this.framingRadius;
    const distance = radius * 3;
    const halfHeight = radius * 1.15;

    if (i === RESULT_PANEL_INDEX) {
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

    const controls = this.controls[i];
    controls.target.copy(this.framingCenter);
    controls.update();
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    if (!this.viewReady) {
      return;
    }
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const source = this.surfaceZonePainting.activeSource();
    if (sessionId === null || !source) {
      this.lastSessionId = null;
      return;
    }
    if (sessionId !== this.lastSessionId) {
      this.lastSessionId = sessionId;
      this.panelSign = { x: 1, y: 1, z: 1 };
      this.message.set(null);
      this.rebuildFraming(source.framingObjects);
      this.refreshClassifications();
      if (this.surfaceZonePainting.isSaved(sessionId)) {
        this.rebuildResultOverlay();
      }
    }

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
      }
      this.controls[i].update();
      if (this.resultOverlay) {
        this.resultOverlay.visible = i === RESULT_PANEL_INDEX;
      }
      this.renderers[i].render(source.scene, camera);
      if (i !== RESULT_PANEL_INDEX) {
        this.drawOverlay(i, camera, width, height);
      }
    }
    if (this.resultOverlay) {
      this.resultOverlay.visible = false;
    }

    source.hiddenDuringView.forEach((object, i) => (object.visible = previousVisibility[i]));
  };

  private rebuildResultOverlay(): void {
    this.disposeResultOverlay();
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const source = this.surfaceZonePainting.activeSource();
    if (sessionId === null || !source) {
      return;
    }
    const session = this.surfaceZonePainting.getSession(sessionId);
    if (!session) {
      return;
    }
    const triangleCount = this.triangleCountOf(source.stlMesh);
    const triangleZone = new Int16Array(triangleCount);
    for (let i = 0; i < triangleCount; i++) {
      triangleZone[i] = this.surfaceZonePainting.zoneIdOfTriangle(sessionId, i) ?? -1;
    }
    const overlay = buildSurfaceZoneOverlay(source.stlMesh, triangleZone, session.voxelZones, DEFAULT_OVERLAY_OPACITY);
    overlay.visible = false;
    source.scene.add(overlay);
    this.resultOverlay = overlay;
  }

  private triangleCountOf(object: THREE.Object3D): number {
    let count = 0;
    object.traverse(child => {
      if (child instanceof THREE.Mesh) {
        const position = child.geometry.getAttribute('position');
        if (position) {
          const index = child.geometry.index;
          count += (index ? index.count : position.count) / 3;
        }
      }
    });
    return count;
  }

  private disposeResultOverlay(): void {
    if (this.resultOverlay) {
      disposeSurfaceZoneOverlay(this.resultOverlay);
      this.resultOverlay = null;
    }
  }

  private drawOverlay(index: number, camera: THREE.OrthographicCamera, width: number, height: number): void {
    const overlayCanvas = this.overlayRefs?.get(index)?.nativeElement;
    const sessionId = this.surfaceZonePainting.activeSessionId();
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
    const session = this.surfaceZonePainting.getSession(sessionId);
    if (!state || !session) {
      return;
    }
    const { grid } = session;
    const pixelsPerWorldUnit = (width / (camera.right - camera.left)) * camera.zoom;
    const cellPixelSize = grid.cellSize * pixelsPerWorldUnit;
    const projected = new THREE.Vector3();

    for (let v = 0; v < state.height; v++) {
      for (let u = 0; u < state.width; u++) {
        const cellState = state.cells[u + v * state.width];
        if (cellState.kind === 'empty') {
          continue;
        }
        const fill = this.fillFor(cellState);
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

  private fillFor(state: SurfaceZoneCellState): string | null {
    switch (state.kind) {
      case 'empty':
        return null;
      case 'available':
        return AVAILABLE_FILL;
      case 'excluded':
        return EXCLUDED_FILL;
      case 'pending':
        return PENDING_FILL;
      case 'zoned':
        return darkenZoneColorCss(state.color);
    }
  }
}
