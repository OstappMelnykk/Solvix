import { AfterViewInit, Component, ElementRef, OnDestroy, QueryList, ViewChildren, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Axis, AXES, ZonePaintingService, axisCoords, projectedCoords } from '../../state/zone-painting.service';
import { MIN_SHELL_SUBDIVISIONS, SurfaceZoneCellState, SurfaceZonePaintingService } from '../../state/surface-zone-painting.service';
import { labelConnectedComponents } from '../../state/mask-connectivity';
import { worldPointToShellCell } from '../../geometry/surface-shell-grid';
import { voxelCenter } from '../../geometry/voxel-grid-contract';
import { buildSurfaceZoneOverlay, disposeSurfaceZoneOverlay } from '../../geometry/scene-objects/surface-zone-overlay';
import { darkenZoneColorCss } from '../../geometry/scene-objects/zone-overlay';
import { NotificationService } from '../../state/notification.service';

type AxisSign = 1 | -1;

const AVAILABLE_FILL = 'rgba(180, 185, 190, 0.35)';
const EXCLUDED_FILL = 'rgba(10, 10, 12, 0.55)';
const PENDING_FILL = 'rgba(255, 255, 255, 0.55)';
// The pending mask's FIRST connected component keeps PENDING_FILL - these
// are for every ADDITIONAL disconnected "island" (2nd, 3rd, ...), a direct
// visual hint on the geometry itself for what would otherwise only surface
// as a text error at "Завершити виділення" ("Виділення розірвано на
// кілька ділянок..."): distinct, attention-grabbing colors so the user can
// see AT A GLANCE which separate blobs still need to be bridged together.
// Same palette as ZonePaintingComponent's own DISCONNECTED_ISLAND_FILLS.
const DISCONNECTED_ISLAND_FILLS: readonly string[] = ['rgba(230, 57, 70, 0.65)', 'rgba(255, 190, 11, 0.65)', 'rgba(131, 56, 236, 0.65)'];
// Fully opaque - the result panel now hides the original STL reference
// while showing this (see animate()'s stlMeshWasVisible handling), so
// there's nothing underneath this needs to blend with any more; a crisp,
// fully-colored view of the model itself was the actual point of this
// panel.
const DEFAULT_OVERLAY_OPACITY = 1;

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

// The second step of each zone's 2-step wizard (see SurfaceZonePaintingService's
// own header comment) - opens right after ZonePaintingComponent commits one
// voxel zone, and paints the SAME 3-axis mask mechanism directly onto a
// finer grid built from the STL surface, tying that one zone to its own
// patch of the actual surface.
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
  private readonly zonePainting = inject(ZonePaintingService);
  private readonly notifications = inject(NotificationService);

  readonly axes = AXES;
  readonly panelIndices = Array.from({ length: PANEL_COUNT }, (_, i) => i);

  private panelSign: Record<Axis, AxisSign> = { x: 1, y: 1, z: 1 };
  private viewStateCache: Partial<Record<Axis, { width: number; height: number; cells: SurfaceZoneCellState[] }>> = {};

  private renderers: THREE.WebGLRenderer[] = [];
  private cameras: THREE.OrthographicCamera[] = [];
  private controls: OrbitControls[] = [];
  private cameraHalfHeights: number[] = new Array(PANEL_COUNT).fill(1);
  private readonly lastPanelSizes: { width: number; height: number }[] = Array.from({ length: PANEL_COUNT }, () => ({ width: 0, height: 0 }));
  // 0, not window.devicePixelRatio, deliberately - these renderers are
  // created lazily (ensureRenderersReady, only once this tool is actually
  // open), so a mismatching sentinel here just means "not set up yet",
  // same reasoning as lastPanelSizes starting at 0.
  private lastPixelRatio = 0;
  private readonly framingCenter = new THREE.Vector3();
  private framingRadius = 1;
  private lastSessionId: number | null = null;
  private frameId = 0;
  private viewReady = false;
  // Without preventDefault() here, a lost WebGL context on any of these 4
  // canvases is PERMANENT - the browser only ever attempts to restore a
  // context whose loss event was explicitly prevented. Matches
  // WorldCanvasComponent's own long-standing handling, which these 4
  // canvases never had.
  private readonly onContextLost = (event: Event) => event.preventDefault();

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  // Which painting panel is currently mid-stroke (left button held down),
  // or null between strokes - a stroke never spans 2 panels even if the
  // cursor somehow leaves one canvas and enters another while the button
  // is still down.
  private paintingPanelIndex: number | null = null;
  // [0,1,2] shell cells - see brushSizes/setBrushRadius below.
  private brushRadiusValue = 1;

  // The colored result overlay - rebuilt after every successful
  // finishSelection commit (SurfaceZonePaintingService keeps its
  // triangle->zone dictionary current the same way), kept hidden except
  // during the result panel's own render() call, same idiom as
  // ZonePaintingComponent's own zoneOverlayGroup.
  private resultOverlay: THREE.Object3D | null = null;

  // Deliberately does NOT create the 4 WebGLRenderers here (unlike
  // SixViewOverlayComponent/ZonePaintingComponent, which both do create
  // theirs eagerly, always-mounted at app.component.html) - this component
  // is the 4th such always-mounted overlay, and creating its 4 contexts
  // unconditionally on every app load pushed the app's total WebGL context
  // count (3 worlds + 6 six-view + 4 zone-painting + 4 here = 17) past
  // Chrome's default per-page limit (commonly 16), which silently lost an
  // EARLIER context instead (the Ideal World canvas going blank - a real
  // regression this caused). ensureRenderersReady()/teardownRenderers()
  // below create and free these 4 contexts only while this tool is
  // actually open, keeping the steady-state total back at the previously
  // safe 13.
  ngAfterViewInit(): void {
    this.viewReady = true;
    this.animate();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.teardownRenderers();
    this.disposeResultOverlay();
  }

  private ensureRenderersReady(): boolean {
    if (this.renderers.length > 0) {
      return true;
    }
    const canvases = this.canvasRefs.toArray().map(ref => ref.nativeElement);
    // The host only just stopped being [hidden] (isHidden() flips the
    // instant activeSessionId() becomes non-null, in the SAME tick this
    // checks it) - Angular's own change detection hasn't necessarily run
    // yet by the time this rAF-driven animate() loop gets here, so the
    // canvases can still measure 0x0 for a frame or two. Wait for real
    // dimensions before creating anything sized off them.
    if (canvases.some(canvas => canvas.clientWidth === 0 || canvas.clientHeight === 0)) {
      return false;
    }
    canvases.forEach(canvas => canvas.addEventListener('webglcontextlost', this.onContextLost, false));
    this.renderers = canvases.map(canvas => new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true }));
    // Without this, three.js defaults every renderer to a pixel ratio of 1
    // regardless of the actual display - sharp on a plain 1x monitor, but
    // visibly soft/pixelated on anything HiDPI (Retina, most modern
    // external monitors too).
    this.lastPixelRatio = window.devicePixelRatio;
    this.renderers.forEach(renderer => renderer.setPixelRatio(this.lastPixelRatio));
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
    this.lastPanelSizes.forEach(size => {
      size.width = 0;
      size.height = 0;
    });
    return true;
  }

  private teardownRenderers(): void {
    if (this.renderers.length === 0) {
      return;
    }
    this.canvasRefs.forEach(ref => ref.nativeElement.removeEventListener('webglcontextlost', this.onContextLost));
    this.controls.forEach(controls => controls.dispose());
    // dispose() only, deliberately NOT forceContextLoss() - these 4
    // <canvas> elements are never removed from the DOM (this component is
    // mounted once and only ever [hidden]), so the SAME canvas gets reused
    // on the next open. forceContextLoss() permanently kills a canvas's
    // context, which made a later `new THREE.WebGLRenderer({ canvas })` on
    // reopen read capabilities off a dead context and throw. dispose()
    // alone doesn't lose the context - a canvas that already has one just
    // hands the SAME live context back to the next WebGLRenderer created
    // on it, so reopening stays safe.
    this.renderers.forEach(renderer => renderer.dispose());
    this.renderers = [];
    this.cameras = [];
    this.controls = [];
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

  // Re-opens step 1 (ZonePaintingService) with the ORIGINAL source this
  // step was opened from - see SurfaceZonePaintingSource.step1Source's own
  // comment for why that has to be carried through rather than
  // reconstructed here. Lets the user redo THIS zone's voxels before
  // finishing it - it is never "the previous zone in a list" anymore, only
  // ever the one this wizard invocation is for.
  goToStep1(): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const source = this.surfaceZonePainting.activeSource();
    if (sessionId === null || !source) {
      return;
    }
    this.zonePainting.open(sessionId, source.step1Source);
    this.surfaceZonePainting.close();
  }

  // The ONE zone this wizard invocation is painting into - shown as a
  // single, unmissable banner (color swatch + "Зона N з M"). N/M are still
  // meaningful even though this step no longer walks a sequence itself:
  // ZonePaintingService's own zone list gives the total, and this session's
  // activeVoxelZoneId (set once, by ZonePaintingComponent, right before
  // this step opened) gives which one.
  currentZoneLabel(): string {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null) {
      return '';
    }
    const activeId = this.surfaceZonePainting.getActiveVoxelZoneId(sessionId);
    const total = this.zonePainting.getSession(sessionId)?.zones.length ?? 0;
    return activeId === null ? '' : `Зона ${activeId + 1} з ${total}`;
  }

  currentZoneColor(): string {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null) {
      return '#888';
    }
    const activeId = this.surfaceZonePainting.getActiveVoxelZoneId(sessionId);
    const zones = this.surfaceZonePainting.getSession(sessionId)?.voxelZones ?? [];
    return zones.find(zone => zone.voxelZoneId === activeId)?.color ?? '#888';
  }

  coverageText(): string {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.surfaceZonePainting.coverage(sessionId);
    return coverage ? `Розмічено: ${coverage.assigned} / ${coverage.total} ділянок сітки` : '';
  }

  // The sidebar's top status bar - same idea as ZonePaintingComponent's own
  // coveragePercent.
  coveragePercent(): number {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.surfaceZonePainting.coverage(sessionId);
    return coverage && coverage.total > 0 ? Math.round((coverage.assigned / coverage.total) * 100) : 0;
  }

  // Explains why "Завершити зону" is disabled - shown right under it
  // instead of leaving the user to guess from a plain disabled button.
  finishZoneDisabledReason(): string | null {
    if (this.canFinishZone()) {
      return null;
    }
    return 'Спочатку виділіть хоч одну ділянку для поточної зони.';
  }

  // Commits whatever's currently pending into the active zone - can be
  // called any number of times per zone (a thin root's front and back
  // surface, physically disjoint but the same logical zone, each need
  // their own commit). Also refreshes the live 3D result preview so newly
  // committed cells show up in it immediately, not just after "Завершити
  // зону".
  finishSelection(): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const { assigned, disconnected } = this.surfaceZonePainting.finishSelection(sessionId);
    this.refreshClassifications();
    if (disconnected) {
      this.notifications.error('Виділення розірвано на кілька ділянок - з\'єднайте їх або завершіть частинами.');
    } else if (assigned === 0) {
      this.notifications.error('Перетин 3 областей порожній - жодної ділянки не додано.');
    } else {
      this.notifications.success(`Додано ${assigned} ділянок до обраної зони.`);
      this.rebuildResultOverlay();
    }
  }

  // Whether this zone has received at least one committed selection (or has
  // one still pending that "Завершити зону" will auto-commit) - the only
  // requirement to finish it now, unlike the old global "every zone used,
  // 100% covered" gate.
  canFinishZone(): boolean {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const activeZoneId = sessionId === null ? null : this.surfaceZonePainting.getActiveVoxelZoneId(sessionId);
    if (sessionId === null || activeZoneId === null) {
      return false;
    }
    return this.surfaceZonePainting.isZoneUsed(sessionId, activeZoneId) || this.hasPendingSelection(sessionId);
  }

  private hasPendingSelection(sessionId: number): boolean {
    return AXES.some(axis => this.surfaceZonePainting.pendingMask(sessionId, axis)?.includes(1) ?? false);
  }

  // "Завершити зону" - auto-commits any still-pending stroke, then closes
  // this step (and so the whole 2-step wizard for this zone) straight back
  // to the zone list. No separate save(): SurfaceZonePaintingService
  // already keeps its triangle->zone dictionary current after every
  // finishSelection commit.
  finishZoneStep2(): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const activeZoneId = sessionId === null ? null : this.surfaceZonePainting.getActiveVoxelZoneId(sessionId);
    if (sessionId === null || activeZoneId === null) {
      return;
    }
    this.finishSelection();
    if (this.surfaceZonePainting.isZoneUsed(sessionId, activeZoneId)) {
      this.surfaceZonePainting.close();
    } else {
      this.notifications.error('Спочатку виділіть хоч одну ділянку для поточної зони.');
    }
  }

  readonly minShellSubdivisions = MIN_SHELL_SUBDIVISIONS;

  // How finely each voxel cell is subdivided for THIS shell grid
  // (geometry/surface-shell-grid.ts) - shown here, on step 2 itself, since
  // this is what the grid the user is currently painting on was actually
  // built with. May read back LOWER than what was last typed if
  // SurfaceZonePaintingService.open silently capped it against the current
  // voxel grid's own size (see that method's own comment) - always the
  // truth about the grid actually in use, never the raw input value.
  shellSubdivisions(): number {
    return this.surfaceZonePainting.subdivisions();
  }

  // Bound as the number input's real `max` attribute (surface-zone-painting.
  // component.html) - see maxSubdivisionsForSession's own comment for why a
  // real HTML max, not just a post-hoc JS clamp, is what actually stops the
  // browser's spinner/scroll from visibly outrunning the clamped value.
  maxShellSubdivisions(): number {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    return sessionId === null ? this.shellSubdivisions() : this.surfaceZonePainting.maxSubdivisionsForSession(sessionId);
  }

  // Rebuilds the CURRENT session's shell grid at the new resolution, live,
  // with no confirmation - changing this mid-session does discard whatever
  // was already painted here (the grid's own cell layout changes), but the
  // user explicitly asked for immediate, no-prompt feedback while adjusting
  // this value, not a dialog on every change.
  onShellSubdivisionsChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const source = this.surfaceZonePainting.activeSource();
    if (sessionId === null || !source || !Number.isFinite(value)) {
      return;
    }
    this.surfaceZonePainting.setSubdivisions(value);
    this.surfaceZonePainting.open(sessionId, source);
    this.refreshClassifications();
    this.disposeResultOverlay();
  }

  // Brush painting, not click/rectangle - drag continuously and every cell
  // the cursor passes over (within the current brush radius) gets painted,
  // like a paintbrush stroke. Left button only (event.button === 0): the
  // OLD click/rectangle version reacted to EVERY pointer button, which
  // meant a right-drag pan gesture was ALSO tracked as a paint attempt and
  // fired a toggleCell/selectRect the instant the button was released -
  // fighting with OrbitControls' own right-drag pan (mouseButtons.RIGHT =
  // THREE.MOUSE.PAN, see ngAfterViewInit) rather than just letting it
  // through untouched.
  onPointerDown(index: number, event: PointerEvent): void {
    if (index === RESULT_PANEL_INDEX || event.button !== 0) {
      return;
    }
    this.paintingPanelIndex = index;
    this.paintAt(index, event);
  }

  onPointerMove(index: number, event: PointerEvent): void {
    if (this.paintingPanelIndex !== index) {
      return;
    }
    this.paintAt(index, event);
  }

  onPointerUp(index: number): void {
    if (this.paintingPanelIndex === index) {
      this.paintingPanelIndex = null;
    }
  }

  // [0, 1, 2] were the original 3 - the 3 added on top (4, 8, 16) are the
  // previous largest (2) times the powers of two 2/4/8, for quickly
  // covering much bigger areas on large/dense grids without needing many
  // separate strokes at radius 2.
  readonly brushSizes: readonly number[] = [0, 1, 2, 4, 8, 16];

  // The dot icon's diameter for a given brush radius (surface-zone-painting.
  // component.html) - sqrt-scaled and capped rather than the old linear `6 +
  // size * 5`, which was fine up to size 2 (16px) but would blow past the
  // 32px button box entirely at size 16 (86px). Still strictly increasing
  // and visually distinct across the whole [0, 16] range, just compressed
  // at the top end where the ACTUAL painted area (proportional to radius²)
  // is already growing much faster than any dot could show anyway.
  dotSizeFor(size: number): number {
    return Math.min(26, 6 + Math.sqrt(size) * 6);
  }
  // 'brush' only ever ADDS cells to the pending selection, 'eraser' only
  // ever REMOVES them - both share the exact same footprint/ordering logic
  // in paintAt below, just filtered to the opposite mask state. Erasing
  // only ever touches PENDING cells (not yet committed via
  // finishSelection) - a cell already claimed by a finished zone can't be
  // toggled at all (ZonePaintingService-style rule, enforced by
  // toggleCell itself), matching how a single click could always remove a
  // pending cell but never an already-zoned one.
  private paintMode: 'brush' | 'eraser' = 'brush';

  brushMode(): 'brush' | 'eraser' {
    return this.paintMode;
  }

  setBrushMode(mode: 'brush' | 'eraser'): void {
    this.paintMode = mode;
  }

  brushRadius(): number {
    return this.brushRadiusValue;
  }

  setBrushRadius(radius: number): void {
    this.brushRadiusValue = radius;
  }

  // Paints (or erases) every cell within the current brush radius of
  // wherever (index, event) raycasts to, ordered closest-to-center first so
  // each new cell already touches one just added/removed - the same
  // 4-connectivity toggleCell enforces per cell would otherwise reject an
  // outer-ring cell handled before its inner neighbor.
  private paintAt(index: number, event: PointerEvent): void {
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const cell = this.raycastCell(index, event);
    if (sessionId === null || !cell) {
      return;
    }
    const axis = this.axes[index];
    const grid = this.surfaceZonePainting.getSession(sessionId)?.grid;
    const mask = this.surfaceZonePainting.pendingMask(sessionId, axis);
    if (!grid || !mask) {
      return;
    }
    const width = axis === 'x' ? grid.countY : grid.countX;
    const height = axis === 'x' ? grid.countZ : axis === 'y' ? grid.countZ : grid.countY;
    const center = projectedCoords(axis, cell.ix, cell.iy, cell.iz);
    const radius = this.brushRadiusValue;

    const footprint: { u: number; v: number; distance: number }[] = [];
    for (let dv = -radius; dv <= radius; dv++) {
      for (let du = -radius; du <= radius; du++) {
        const distance = Math.abs(du) + Math.abs(dv);
        if (distance > radius) {
          continue; // diamond-shaped brush, not square
        }
        footprint.push({ u: center.u + du, v: center.v + dv, distance });
      }
    }
    footprint.sort((a, b) => a.distance - b.distance);

    const erasing = this.paintMode === 'eraser';
    let changedAny = false;
    for (const { u, v } of footprint) {
      if (u < 0 || v < 0 || u >= width || v >= height) {
        continue;
      }
      const isPending = mask[u + v * width] === 1;
      // Brush: skip cells already pending (never re-toggle them off).
      // Eraser: skip cells that AREN'T pending (nothing there to remove).
      if (erasing !== isPending) {
        continue;
      }
      if (this.surfaceZonePainting.toggleCell(sessionId, axis, u, v)) {
        changedAny = true;
      }
    }
    if (changedAny) {
      this.refreshClassifications();
    }
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
      this.teardownRenderers();
      return;
    }
    if (!this.ensureRenderersReady()) {
      return; // canvases not measurable yet - retry next frame
    }
    if (sessionId !== this.lastSessionId) {
      this.lastSessionId = sessionId;
      this.panelSign = { x: 1, y: 1, z: 1 };
      this.rebuildFraming(source.framingObjects);
      this.refreshClassifications();
      if (this.surfaceZonePainting.getTriangleZones(sessionId)) {
        this.rebuildResultOverlay();
      }
    }

    // Restored in a `finally` below - see SixViewOverlayComponent's animate()
    // for why (a panel throwing mid-loop must never leave the source
    // World's grid/gizmo permanently hidden).
    const previousVisibility = source.hiddenDuringView.map(object => object.visible);
    source.hiddenDuringView.forEach(object => (object.visible = false));
    const stlMeshWasVisible = source.stlMesh.visible;

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
        this.renderers.forEach(renderer => renderer.setPixelRatio(pixelRatio));
        this.lastPanelSizes.forEach(size => {
          size.width = 0;
          size.height = 0;
        });
      }

      const canvases = this.canvasRefs.toArray();
      for (let i = 0; i < canvases.length; i++) {
        // Each panel in its own try/catch - see SixViewOverlayComponent's
        // animate() for why (one bad panel shouldn't stop the other 3, or
        // repeat-throw forever without ever painting anything).
        try {
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
          const showingResult = i === RESULT_PANEL_INDEX && this.resultOverlay !== null;
          if (this.resultOverlay) {
            this.resultOverlay.visible = showingResult;
          }
          // The result panel shows ONLY the fully-opaque colored overlay, not
          // the original (possibly translucent) STL reference underneath it at
          // the exact same position - blending both together read as a faint,
          // muddy wash rather than a crisp "here's the model, painted by
          // zone" view, which was the actual point of this panel.
          source.stlMesh.visible = stlMeshWasVisible && !showingResult;
          this.renderers[i].render(source.scene, camera);
          if (i !== RESULT_PANEL_INDEX) {
            this.drawOverlay(i, camera, width, height);
          }
        } catch (error) {
          console.error(`[SurfaceZonePaintingComponent] panel ${i} failed to render, skipping it this frame`, error);
        }
      }
      if (this.resultOverlay) {
        this.resultOverlay.visible = false;
      }
      source.stlMesh.visible = stlMeshWasVisible;
    } finally {
      source.hiddenDuringView.forEach((object, i) => (object.visible = previousVisibility[i]));
    }
  };

  private rebuildResultOverlay(): void {
    this.disposeResultOverlay();
    const sessionId = this.surfaceZonePainting.activeSessionId();
    const source = this.surfaceZonePainting.activeSource();
    if (sessionId === null || !source) {
      return;
    }
    const session = this.surfaceZonePainting.getSession(sessionId);
    const triangleZone = this.surfaceZonePainting.getTriangleZones(sessionId);
    if (!session || !triangleZone) {
      return;
    }
    const overlay = buildSurfaceZoneOverlay(source.stlMesh, triangleZone, session.voxelZones, DEFAULT_OVERLAY_OPACITY);
    overlay.visible = false;
    source.scene.add(overlay);
    this.resultOverlay = overlay;
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
    // Labels this axis's PENDING mask by connected component, so a
    // disconnected selection (allowed while painting - only rejected at
    // "Завершити виділення") shows each separate island in its own color
    // instead of one uniform pending fill (see DISCONNECTED_ISLAND_FILLS'
    // own comment).
    const pendingMask = this.surfaceZonePainting.pendingMask(sessionId, axis);
    const pendingLabels = pendingMask ? labelConnectedComponents(pendingMask, state.width, state.height) : null;

    for (let v = 0; v < state.height; v++) {
      for (let u = 0; u < state.width; u++) {
        const cellState = state.cells[u + v * state.width];
        if (cellState.kind === 'empty') {
          continue;
        }
        const fill =
          cellState.kind === 'pending'
            ? this.pendingFillFor(pendingLabels?.labels[u + v * state.width] ?? 0)
            : this.fillFor(cellState);
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
        return this.pendingFillFor(0);
      case 'zoned':
        return darkenZoneColorCss(state.color);
    }
  }

  // component 0 (whichever island the flood fill happens to reach first -
  // not necessarily "the first one the user painted") keeps PENDING_FILL;
  // every later component cycles through DISCONNECTED_ISLAND_FILLS instead
  // - see that constant's own comment.
  private pendingFillFor(component: number): string {
    if (component <= 0) {
      return PENDING_FILL;
    }
    return DISCONNECTED_ISLAND_FILLS[(component - 1) % DISCONNECTED_ISLAND_FILLS.length];
  }
}
