import { AfterViewInit, Component, ElementRef, OnDestroy, QueryList, ViewChildren, inject, signal } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Axis, AXES, ZoneCellState, ZonePaintingService, axisCoords, projectedCoords } from '../../state/zone-painting.service';
import { voxelCenter } from '../../geometry/voxel-grid-contract';
import { getVoxelCellByInstanceId } from '../../geometry/scene-objects/voxels';
import { buildZoneOverlayGroup, disposeZoneOverlayGroup, setZoneOverlayOpacity, darkenZoneColorCss } from '../../geometry/scene-objects/zone-overlay';
import { WeightedOitRenderer } from '../../rendering/weighted-oit';
import { VoxelizationService } from '../../state/voxelization.service';
import { ImportedReferenceDisplayService } from '../../state/imported-reference-display.service';

type AxisSign = 1 | -1;

const CLICK_MOVE_THRESHOLD_PX = 4;

const AVAILABLE_FILL = 'rgba(180, 185, 190, 0.35)';
const EXCLUDED_FILL = 'rgba(10, 10, 12, 0.55)';

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

  readonly axes = AXES; // panels 0-2 always show axes[i] - fixed, only the side (sign) is switchable
  readonly panelIndices = Array.from({ length: PANEL_COUNT }, (_, i) => i); // 0-2 painting views, 3 the free-orbit result
  readonly commitMessage = signal<string | null>(null);

  private panelSign: Record<Axis, AxisSign> = { x: 1, y: 1, z: 1 };
  private viewStateCache: Partial<Record<Axis, { width: number; height: number; cells: ZoneCellState[] }>> = {};

  private renderers: THREE.WebGLRenderer[] = [];
  // Same stable STL+voxel transparency fix as WorldCanvasComponent's own
  // main view (rendering/weighted-oit.ts) - one instance per panel (4 here:
  // the 3 fixed-axis painting views plus the free-orbit 3D result), since
  // each panel is its own WebGLRenderer/WebGL context.
  private oitRenderers: WeightedOitRenderer[] = [];
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

  // Rebuilt whenever the set of committed zones changes (rebuildZoneOverlayMesh) -
  // one colored box per zoned voxel, added to the shared Scene but kept
  // hidden except during the result panel's own render() call (see animate),
  // so panels 0-2 (which show their own flat 2D overlay instead) never see
  // it doubled up on top of the real cubes.
  // One InstancedMesh PER ZONE (not per-instance color on a single shared
  // mesh) - see rebuildZoneOverlayMesh's own comment for why.
  private zoneOverlayGroup: THREE.Group | null = null;

  ngAfterViewInit(): void {
    const canvases = this.canvasRefs.toArray().map(ref => ref.nativeElement);
    this.renderers = canvases.map(canvas => new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true }));
    this.oitRenderers = this.renderers.map(renderer => new WeightedOitRenderer(renderer));
    this.cameras = canvases.map(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000));
    this.controls = this.cameras.map((camera, i) => {
      const controls = new OrbitControls(camera, canvases[i]);
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
      return controls;
    });
    this.viewReady = true;
    this.animate();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.controls.forEach(controls => controls.dispose());
    this.oitRenderers.forEach(renderer => renderer.dispose());
    this.renderers.forEach(renderer => renderer.dispose());
    this.disposeZoneOverlayMesh();
  }

  isHidden(): boolean {
    return this.zonePainting.activeSessionId() === null;
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
    this.zonePainting.close();
  }

  // "Скинути всі зони" - destructive (loses every committed zone AND
  // whatever's currently pending), so confirm before actually doing it.
  resetZones(): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    if (!window.confirm('Скинути всі зони й почати розмітку заново? Це незворотно.')) {
      return;
    }
    this.zonePainting.resetZones(sessionId);
    this.commitMessage.set(null);
    this.refreshClassifications();
    this.rebuildZoneOverlayMesh();
  }

  zonesFor(): { readonly id: number; readonly color: string; readonly voxelCount: number }[] {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return [];
    }
    return [...(this.zonePainting.getSession(sessionId)?.zones ?? [])];
  }

  coverageText(): string {
    const sessionId = this.zonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.zonePainting.coverage(sessionId);
    return coverage ? `Розмічено: ${coverage.assigned} / ${coverage.total} вокселів` : '';
  }

  nextZoneColor(): string {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId === null ? '#888' : this.zonePainting.nextZoneColor(sessionId);
  }

  // The color picker next to each zone in the list - cosmetic only, never
  // changes which voxels belong to the zone. Refreshes both places the
  // color is actually drawn: the 3 flat panels' 'zoned' cell fill
  // (refreshClassifications, cached in viewStateCache) and the 3D result
  // panel (rebuildZoneOverlayMesh).
  setZoneColor(zoneId: number, color: string): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    this.zonePainting.setZoneColor(sessionId, zoneId, color);
    this.refreshClassifications();
    this.rebuildZoneOverlayMesh();
  }

  finishZone(): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const assigned = this.zonePainting.finishZone(sessionId);
    this.refreshClassifications();
    this.rebuildZoneOverlayMesh();

    if (assigned === 0) {
      this.commitMessage.set("Перетин 3 областей порожній - жодного вокселя не додано. Зона не створена.");
      return;
    }

    const coverage = this.zonePainting.coverage(sessionId);
    if (coverage && coverage.assigned >= coverage.total) {
      // Every occupied voxel now belongs to some zone - nothing left to
      // paint. Unlike before, this no longer closes the window on its own -
      // the user decides when to leave (canSave()'s "Зберегти" button below
      // just becomes available).
      this.commitMessage.set(`Зону створено: ${assigned} вокселів. Усі вокселі вже розмічені по зонах.`);
    } else {
      this.commitMessage.set(`Зону створено: ${assigned} вокселів.`);
    }
  }

  // Backing state + action for the "Зберегти" button - only appears once
  // coverage() reports every occupied voxel assigned to some zone (see
  // ZonePaintingService.save's own comment on what "saved" actually marks).
  canSave(): boolean {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null || this.isSaved()) {
      return false;
    }
    const coverage = this.zonePainting.coverage(sessionId);
    return coverage !== null && coverage.total > 0 && coverage.assigned >= coverage.total;
  }

  isSaved(): boolean {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId !== null && this.zonePainting.isSaved(sessionId);
  }

  save(): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    if (this.zonePainting.save(sessionId)) {
      this.commitMessage.set('Зони збережено.');
    }
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
    const sessionId = this.zonePainting.activeSessionId();

    if (this.dragPanelIndex === index && sessionId !== null && this.dragStart && this.dragCurrent && downClient) {
      const axis = this.axes[index];
      const { u: u0, v: v0 } = this.dragStart;
      const { u: u1, v: v1 } = this.dragCurrent;
      const ok =
        u0 === u1 && v0 === v1
          ? this.zonePainting.toggleCell(sessionId, axis, u0, v0)
          : this.zonePainting.selectRect(sessionId, axis, u0, v0, u1, v1);
      this.commitMessage.set(
        ok ? null : "Нічого не змінено - клітинки вже зайняті іншою зоною, недоступні, або дія розірвала б область на 2+ частини."
      );
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
    if (!batchedFill) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.cameras[index]);
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

    const controls = this.controls[i];
    controls.target.copy(this.framingCenter);
    controls.update();
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    if (!this.viewReady) {
      return;
    }
    const sessionId = this.zonePainting.activeSessionId();
    const source = this.zonePainting.activeSource();
    if (sessionId === null || !source) {
      this.lastSessionId = null;
      return;
    }
    if (sessionId !== this.lastSessionId) {
      this.lastSessionId = sessionId;
      this.panelSign = { x: 1, y: 1, z: 1 };
      this.commitMessage.set(null);
      this.rebuildFraming(source.framingObjects);
      this.refreshClassifications();
      this.rebuildZoneOverlayMesh();
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
        this.oitRenderers[i].setSize(width, height);
      }
      this.controls[i].update();
      // The colored-zone overlay mesh lives in the shared Scene but must
      // only be visible for the result panel's OWN render() call - panels
      // 0-2 show their flat 2D projection instead (drawOverlay below) and
      // would otherwise show the 3D boxes doubled up underneath it.
      if (this.zoneOverlayGroup) {
        this.zoneOverlayGroup.visible = i === RESULT_PANEL_INDEX;
      }
      this.oitRenderers[i].render(source.scene, camera);
      if (i !== RESULT_PANEL_INDEX) {
        this.drawOverlay(i, camera, width, height);
      }
    }
    if (this.zoneOverlayGroup) {
      this.zoneOverlayGroup.visible = false;
    }

    source.hiddenDuringView.forEach((object, i) => (object.visible = previousVisibility[i]));
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

    for (let v = 0; v < state.height; v++) {
      for (let u = 0; u < state.width; u++) {
        const cellState = state.cells[u + v * state.width];
        if (cellState.kind === 'empty') {
          continue;
        }
        const fill = this.fillFor(cellState, currentZoneColor);
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
        return withAlpha(currentZoneColor, 0.55);
      case 'zoned':
        return darkenZoneColorCss(state.color);
    }
  }
}