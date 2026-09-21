import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ZonePaintingService, ZonePaintingSource } from '../../state/zone-painting.service';
import { SurfaceZonePaintingService } from '../../state/surface-zone-painting.service';
import { VoxelizationService } from '../../state/voxelization.service';
import { buildZoneOverlayGroup, disposeZoneOverlayGroup, setZoneOverlayOpacity } from '../../geometry/scene-objects/zone-overlay';
import { SurfaceZoneOverlayZone, buildSurfaceZoneOverlay, disposeSurfaceZoneOverlay } from '../../geometry/scene-objects/surface-zone-overlay';
import { WeightedOitRenderer } from '../../rendering/weighted-oit';
import { WebglContextBudgetService } from '../../state/webgl-context-budget.service';

// A separate, globally-mounted overlay (app.component.html), NOT nested
// inside ZoneListComponent's own template - ZoneListComponent explicitly
// keeps NO 3D rendering of its own, and already has an extensive spec file
// that creates a fresh instance per test; nesting a real WebGL-rendering
// child there would mean real WebGLRenderer create/destroy cycles on every
// one of those 30+ tests for nothing they actually exercise - matching this
// codebase's convention of never writing a .spec.ts for a component with a
// live requestAnimationFrame render loop.
//
// Deliberately NOT a from-scratch preview: per explicit request, this is
// meant to look exactly like the wizard's own "3D результат" panel (the
// 4th, free-orbit panel already in ZonePaintingComponent for voxels and
// SurfaceZonePaintingComponent for STL) - so it reuses those SAME live
// scene objects (ZonePaintingService.activeSource()'s scene/voxelPreview/
// stlMesh) and the SAME rendering technique (WeightedOitRenderer for the
// voxel panel, buildZoneOverlayGroup/buildSurfaceZoneOverlay for the
// colored zones), not a custom-built simplified scene. The only difference
// from those 2 wizard panels is that both show at once, continuously, on
// the list screen instead of one at a time inside the wizard.
//
// Visually combined with ZoneListComponent purely through layout: this
// occupies exactly the left 50% of the screen (its own :host), and
// ZoneListComponent's own right-hand panel opaquely covers the other 50% -
// see each component's own .scss for how that split is kept in sync.
@Component({
  selector: 'app-zone-preview',
  standalone: true,
  imports: [NgFor, NgIf],
  host: { '[hidden]': 'isHidden()' },
  templateUrl: './zone-preview.component.html',
  styleUrl: './zone-preview.component.scss'
})
export class ZonePreviewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('voxelCanvas') private voxelCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('stlCanvas') private stlCanvasRef?: ElementRef<HTMLCanvasElement>;

  private readonly zonePainting = inject(ZonePaintingService);
  private readonly surfaceZonePainting = inject(SurfaceZonePaintingService);
  private readonly voxelization = inject(VoxelizationService);
  private readonly webglBudget = inject(WebglContextBudgetService);

  private frameId = 0;
  private viewReady = false;
  // Without preventDefault() here, a lost WebGL context on either of these 2
  // canvases is PERMANENT - the browser only ever attempts to restore a
  // context whose loss event was explicitly prevented. Matches
  // WorldCanvasComponent's/the 4-panel tools' own long-standing handling,
  // which this component never had - so a context this browser evicted
  // (too many WebGL contexts open across the app at once) stayed dead here
  // until a full page reload, even after the pressure that caused the
  // eviction was gone.
  private readonly onContextLost = (event: Event) => event.preventDefault();
  // Three.js's own WebGLRenderer re-initializes its internal GL state
  // automatically on 'webglcontextrestored' (see restoreVoxelPanelAfterContextLoss/
  // restoreStlPanelAfterContextLoss below), but never repaints or reapplies
  // size on its own - without an explicit handler, this panel stayed a
  // frozen/blank frame after a restore until some unrelated trigger forced
  // a render (which may never happen for the STL panel once its own zone
  // data stops changing).
  private readonly onVoxelContextRestored = () => this.restoreVoxelPanelAfterContextLoss();
  private readonly onStlContextRestored = () => this.restoreStlPanelAfterContextLoss();
  // Same reasoning as ZonePaintingComponent's own recreatingPanel/
  // lastAttemptedCanvas - set when a canvas's context was evicted and never
  // came back, cleared once ensureVoxelRenderer/ensureStlRenderer notices
  // Angular has actually swapped in the fresh <canvas> bumped generation
  // triggered.
  private voxelRecreating = false;
  private lastAttemptedVoxelCanvas: HTMLCanvasElement | null = null;
  private stlRecreating = false;
  private lastAttemptedStlCanvas: HTMLCanvasElement | null = null;

  // --- Top panel: same technique as ZonePaintingComponent's own "3D
  // результат" panel - the real, live voxelPreview (purple fill + white
  // edges) plus the real colored zone overlay, via the same
  // WeightedOitRenderer every panel in that wizard step already uses. ---
  private voxelRenderer: THREE.WebGLRenderer | null = null;
  private voxelOit: WeightedOitRenderer | null = null;
  private readonly voxelCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  private voxelControls: OrbitControls | null = null;
  private voxelOverlayGroup: THREE.Group | null = null;
  private lastVoxelSessionId: number | null = null;
  private lastVoxelZonesRevision = -1;
  private readonly voxelLastSize = { width: 0, height: 0 };
  private readonly voxelFramingCenter = new THREE.Vector3();
  private voxelFramingRadius = 1;

  // --- Bottom panel: same technique as SurfaceZonePaintingComponent's own
  // "3D результат" panel - the real STL mesh, replaced by the colored
  // buildSurfaceZoneOverlay clone once any STL zone data exists, on a plain
  // (non-OIT) renderer, exactly matching that panel. ---
  private stlRenderer: THREE.WebGLRenderer | null = null;
  private readonly stlCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  private stlControls: OrbitControls | null = null;
  private stlOverlayGroup: THREE.Object3D | null = null;
  private lastStlMesh: THREE.Object3D | null = null;
  private lastTriangleZone: Int16Array | null = null;
  private lastZonesRevisionForStl = -1;
  private readonly stlLastSize = { width: 0, height: 0 };
  private readonly stlFramingCenter = new THREE.Vector3();
  private stlFramingRadius = 1;

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.animate();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.teardownVoxelRenderer();
    this.teardownStlRenderer();
    if (this.voxelOverlayGroup) {
      disposeZoneOverlayGroup(this.voxelOverlayGroup);
    }
    if (this.stlOverlayGroup) {
      disposeSurfaceZoneOverlay(this.stlOverlayGroup);
    }
  }

  // Whether the WHOLE zone-painting feature is open - gates both canvases'
  // *ngFor presence (voxelCanvasKeys/stlCanvasKeys below), same idea as the
  // plain *ngIf this replaced elsewhere in this app: a canvas element only
  // exists (and so only ever holds a real WebGL context) while this is
  // true, so closing the whole zone list is what actually lets the browser
  // reclaim these 2 contexts - not isHidden() below, which flips
  // constantly during normal use (every wizard-step open/close, i.e. every
  // zone add/edit/delete) and must never tear the canvas elements down
  // that often.
  hasActiveSession(): boolean {
    return this.zonePainting.activeSessionId() !== null;
  }

  // Frontmost only while the LIST itself is on screen - both wizard steps
  // (z-index 1100) draw fully on top of this (999) and of the list (1000)
  // alike, so there is no point spending GPU time on either panel while
  // they're up - but the canvas/renderer/context themselves stay alive
  // (see hasActiveSession's own comment for why this must stay separate).
  isHidden(): boolean {
    return !this.hasActiveSession() || this.zonePainting.step1Visible() || this.surfaceZonePainting.activeSessionId() !== null;
  }

  hasStlReference(): boolean {
    return this.zonePainting.activeSource()?.stlMesh != null;
  }

  // *ngFor over a 0-or-1-item array, keyed by a generation number - the
  // template's own way of getting a genuinely fresh <canvas> element on
  // demand (bumped by ensureVoxelRenderer/ensureStlRenderer's own catch
  // block below, on an unrecoverable context loss), while still gating
  // presence on hasActiveSession()/hasStlReference() exactly like the plain
  // *ngIf this replaced. See ZonePaintingComponent's own panelGeneration
  // comment for the full reasoning against a manual DOM replaceWith().
  private voxelCanvasGeneration = 0;
  private stlCanvasGeneration = 0;
  voxelCanvasKeys(): number[] {
    return this.hasActiveSession() ? [this.voxelCanvasGeneration] : [];
  }
  stlCanvasKeys(): number[] {
    return this.hasActiveSession() && this.hasStlReference() ? [this.stlCanvasGeneration] : [];
  }
  trackGeneration = (_: number, gen: number): number => gen;

  // Same value the wizard's own "3D результат" panel already exposes via
  // its "Прозорість зон" slider - this is the on-canvas equivalent for the
  // list page, so it's reachable without opening step 1.
  voxelOverlayOpacityPercent(): number {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId === null ? 75 : Math.round(this.zonePainting.getZoneOverlayOpacity(sessionId) * 100);
  }

  onVoxelOverlayOpacityChange(event: Event): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const percent = Number((event.target as HTMLInputElement).value);
    this.zonePainting.setZoneOverlayOpacity(sessionId, percent / 100);
  }

  // The BASE voxel fill's own opacity (VoxelizationService, same value the
  // wizard's own "Прозорість вокселів" slider and the main settings panel
  // already control) - separate from voxelOverlayOpacityPercent above,
  // which only ever affects the COLORED ZONE layer on top. setOpacity
  // mutates the live shared preview mesh's material directly, so this
  // takes effect immediately with no extra per-frame sync needed here.
  voxelFillOpacityPercent(): number {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId === null ? 0 : Math.round(this.voxelization.getOpacity(sessionId) * 100);
  }

  onVoxelFillOpacityChange(event: Event): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    const percent = Number((event.target as HTMLInputElement).value);
    this.voxelization.setOpacity(sessionId, percent / 100);
  }

  private ensureVoxelRenderer(canvas: HTMLCanvasElement): boolean {
    if (this.voxelRenderer) {
      return true;
    }
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return false;
    }
    if (this.voxelRecreating) {
      if (canvas === this.lastAttemptedVoxelCanvas) {
        return false; // still the old element - Angular hasn't swapped it in yet
      }
      this.voxelRecreating = false;
    }
    this.lastAttemptedVoxelCanvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onVoxelContextRestored, false);
    try {
      this.voxelRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    } catch (error) {
      // The browser doesn't always fire webglcontextrestored for an evicted
      // context (the spec never guarantees it) - see ZonePaintingComponent's
      // own ensureRenderersReady comment for the full reasoning. Bumping
      // voxelCanvasGeneration forces Angular to hand this panel a genuinely
      // new <canvas> element next change detection pass.
      console.error(
        '[ZonePreviewComponent] failed to create the voxel renderer - its context was evicted and never restored by the browser - recreating its <canvas> element',
        error
      );
      canvas.removeEventListener('webglcontextlost', this.onContextLost);
      canvas.removeEventListener('webglcontextrestored', this.onVoxelContextRestored);
      this.evictVoxelPanel();
      return false;
    }
    this.voxelRenderer.setPixelRatio(window.devicePixelRatio);
    // See WebglContextBudgetService's own header comment - may proactively
    // evict some OTHER, currently-idle canvas (this component's own STL one,
    // or a different tool's panel) to stay under the app-wide context cap.
    this.webglBudget.register('zone-preview-voxel', () => this.evictVoxelPanel());
    this.voxelOit = new WeightedOitRenderer(this.voxelRenderer);
    this.voxelControls = new OrbitControls(this.voxelCamera, canvas);
    this.voxelControls.screenSpacePanning = true;
    this.voxelControls.enableDamping = false;
    // A brand-new OrbitControls always defaults its own target to (0,0,0) -
    // voxelCamera itself is a persistent field (never recreated, so its
    // position/zoom already survive a hide/show cycle untouched), and
    // voxelFramingCenter/voxelFramingRadius are ALSO persistent - restoring
    // just the target here reproduces the exact same view the user last had
    // (including any manual rotate/zoom), rather than recomputing a fresh
    // default framing from the model's bounding box every time.
    this.voxelControls.target.copy(this.voxelFramingCenter);
    this.voxelControls.update();
    this.voxelLastSize.width = 0;
    this.voxelLastSize.height = 0;
    return true;
  }

  private ensureStlRenderer(canvas: HTMLCanvasElement): boolean {
    if (this.stlRenderer) {
      return true;
    }
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return false;
    }
    if (this.stlRecreating) {
      if (canvas === this.lastAttemptedStlCanvas) {
        return false;
      }
      this.stlRecreating = false;
    }
    this.lastAttemptedStlCanvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onStlContextRestored, false);
    try {
      this.stlRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    } catch (error) {
      // Same reasoning as ensureVoxelRenderer's own comment.
      console.error(
        '[ZonePreviewComponent] failed to create the STL renderer - its context was evicted and never restored by the browser - recreating its <canvas> element',
        error
      );
      canvas.removeEventListener('webglcontextlost', this.onContextLost);
      canvas.removeEventListener('webglcontextrestored', this.onStlContextRestored);
      this.evictStlPanel();
      return false;
    }
    this.stlRenderer.setPixelRatio(window.devicePixelRatio);
    // See WebglContextBudgetService's own header comment.
    this.webglBudget.register('zone-preview-stl', () => this.evictStlPanel());
    this.stlControls = new OrbitControls(this.stlCamera, canvas);
    this.stlControls.screenSpacePanning = true;
    this.stlControls.enableDamping = false;
    // Same reasoning as ensureVoxelRenderer's own comment.
    this.stlControls.target.copy(this.stlFramingCenter);
    this.stlControls.update();
    this.stlLastSize.width = 0;
    this.stlLastSize.height = 0;
    return true;
  }

  // Forces the voxel panel to give up its real WebGL context right now -
  // either reactively (ensureVoxelRenderer's own catch, above) or proactively
  // (WebglContextBudgetService, when the app-wide context cap is reached and
  // this is the least-recently-used registered canvas). Unlike the 4-panel
  // tools, this one's canvas genuinely IS destroyed (hasActiveSession()'s
  // *ngIf in the template) - teardownVoxelRenderer already does the real
  // release via that, so this only needs to also flag it for a fresh
  // <canvas> element on the next reveal.
  private evictVoxelPanel(): void {
    this.teardownVoxelRenderer();
    this.voxelRecreating = true;
    this.voxelCanvasGeneration++;
  }

  // Same reasoning as evictVoxelPanel, for the STL panel.
  private evictStlPanel(): void {
    this.teardownStlRenderer();
    this.stlRecreating = true;
    this.stlCanvasGeneration++;
  }

  private teardownVoxelRenderer(): void {
    if (!this.voxelRenderer) {
      return;
    }
    this.voxelCanvasRef?.nativeElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.voxelCanvasRef?.nativeElement.removeEventListener('webglcontextrestored', this.onVoxelContextRestored);
    this.voxelControls?.dispose();
    this.voxelOit?.dispose();
    this.voxelRenderer.dispose();
    this.voxelRenderer = null;
    this.voxelOit = null;
    this.voxelControls = null;
    this.webglBudget.unregister('zone-preview-voxel');
    // lastVoxelSessionId is deliberately left untouched - it used to be
    // reset here to force a full rebuildVoxelFraming (recomputed default
    // camera position/zoom from the model's bounding box) on the next
    // reveal, which fixed an old "orbits the world origin" bug but
    // introduced a worse one: it silently threw away the user's own
    // rotate/zoom every single time this panel was merely covered by a
    // wizard step and uncovered again (i.e. on every zone add/edit/delete).
    // ensureVoxelRenderer now restores just the NEW OrbitControls' target
    // from the persistent voxelFramingCenter field instead, which
    // reproduces the exact same view without recomputing it.
  }

  private teardownStlRenderer(): void {
    if (!this.stlRenderer) {
      return;
    }
    this.stlCanvasRef?.nativeElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.stlCanvasRef?.nativeElement.removeEventListener('webglcontextrestored', this.onStlContextRestored);
    this.stlControls?.dispose();
    this.stlRenderer.dispose();
    this.stlRenderer = null;
    this.stlControls = null;
    this.webglBudget.unregister('zone-preview-stl');
    // Same reasoning as teardownVoxelRenderer's own comment.
  }

  // Same isometric-ish free-orbit framing every "3D результат" panel in
  // this app starts at (ZonePaintingComponent/SurfaceZonePaintingComponent's
  // own applyFraming, RESULT_PANEL_INDEX branch).
  private applyFraming(
    camera: THREE.OrthographicCamera,
    controls: OrbitControls,
    center: THREE.Vector3,
    radius: number,
    canvas: HTMLCanvasElement | undefined
  ): void {
    const distance = radius * 3;
    const halfHeight = radius * 1.15;
    camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 1, 1).normalize(), distance);
    camera.up.set(0, 1, 0);
    camera.zoom = 1;
    camera.near = 0.1;
    camera.far = distance + radius * 10;
    if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      const aspect = canvas.clientWidth / canvas.clientHeight;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
    }
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }

  private rebuildVoxelFraming(source: ZonePaintingSource): void {
    const box = new THREE.Box3();
    source.framingObjects.forEach(object => box.expandByObject(object));
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
    this.voxelFramingCenter.copy(sphere.center);
    this.voxelFramingRadius = Math.max(sphere.radius, 0.01);
    if (this.voxelControls) {
      this.applyFraming(this.voxelCamera, this.voxelControls, this.voxelFramingCenter, this.voxelFramingRadius, this.voxelCanvasRef?.nativeElement);
    }
  }

  private rebuildStlFraming(stlMesh: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(stlMesh);
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
    this.stlFramingCenter.copy(sphere.center);
    this.stlFramingRadius = Math.max(sphere.radius, 0.01);
    if (this.stlControls) {
      this.applyFraming(this.stlCamera, this.stlControls, this.stlFramingCenter, this.stlFramingRadius, this.stlCanvasRef?.nativeElement);
    }
  }

  // Fired when the browser actually restores a lost context on the voxel
  // panel - see ZonePaintingComponent's own restorePanelAfterContextLoss for
  // the full reasoning. voxelCamera/voxelControls are persistent fields
  // (never recreated), so there's no plain-data snapshot to reapply here -
  // just a forced resize + render so the panel doesn't stay a frozen/blank
  // frame until some unrelated trigger repaints it.
  private restoreVoxelPanelAfterContextLoss(): void {
    const canvas = this.voxelCanvasRef?.nativeElement;
    const source = this.zonePainting.activeSource();
    if (!this.voxelRenderer || !this.voxelOit || !this.voxelControls || !canvas || !source || canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return;
    }
    this.voxelLastSize.width = 0;
    this.voxelLastSize.height = 0;
    this.resizeVoxelIfNeeded(canvas);
    this.voxelControls.update();
    this.voxelOit.render(source.scene, this.voxelCamera);
  }

  // Same reasoning as restoreVoxelPanelAfterContextLoss, for the STL panel.
  private restoreStlPanelAfterContextLoss(): void {
    const canvas = this.stlCanvasRef?.nativeElement;
    const source = this.zonePainting.activeSource();
    if (!this.stlRenderer || !this.stlControls || !canvas || !source || canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return;
    }
    this.stlLastSize.width = 0;
    this.stlLastSize.height = 0;
    this.resizeStlIfNeeded(canvas);
    this.stlControls.update();
    this.stlRenderer.render(source.scene, this.stlCamera);
  }

  private rebuildVoxelOverlay(sessionId: number): void {
    const revision = this.zonePainting.zonesRevision(sessionId);
    if (revision === this.lastVoxelZonesRevision) {
      return;
    }
    this.lastVoxelZonesRevision = revision;
    if (this.voxelOverlayGroup) {
      this.voxelOverlayGroup.removeFromParent();
      disposeZoneOverlayGroup(this.voxelOverlayGroup);
      this.voxelOverlayGroup = null;
    }
    const session = this.zonePainting.getSession(sessionId);
    if (!session) {
      return;
    }
    const opacity = this.zonePainting.getZoneOverlayOpacity(sessionId);
    const group = buildZoneOverlayGroup(session.grid, session.zones, (ix, iy, iz) => this.zonePainting.zoneIdAt(sessionId, ix, iy, iz), opacity);
    if (group) {
      group.visible = false;
      this.zonePainting.activeSource()!.scene.add(group);
      this.voxelOverlayGroup = group;
    }
  }

  // Mirrors SurfaceZonePaintingComponent's own rebuildResultOverlay exactly:
  // only replaces the plain STL mesh once real triangle->zone data exists
  // (getTriangleZones only returns non-null after a first committed
  // selection) - before that, the panel just shows the plain STL reference,
  // same as the real one does.
  //
  // Also keyed on zonesRevision, not just triangleZone's own reference:
  // buildSurfaceZoneOverlay bakes each zone's CURRENT color into the mesh's
  // vertex colors at build time - setZoneColor changes a zone's color
  // without ever touching triangleZone (which cell belongs to which zone id
  // doesn't change), so triangleZone alone staying the same reference
  // previously meant a color edit on the list page never got picked up here
  // (the voxel panel's own overlay didn't have this bug - it already keys
  // off zonesRevision alone).
  private rebuildStlOverlay(sessionId: number, stlMesh: THREE.Object3D): void {
    const triangleZone = this.surfaceZonePainting.getTriangleZones(sessionId);
    const zonesRevision = this.zonePainting.zonesRevision(sessionId);
    if (triangleZone === this.lastTriangleZone && zonesRevision === this.lastZonesRevisionForStl) {
      return;
    }
    this.lastTriangleZone = triangleZone;
    this.lastZonesRevisionForStl = zonesRevision;
    if (this.stlOverlayGroup) {
      this.stlOverlayGroup.removeFromParent();
      disposeSurfaceZoneOverlay(this.stlOverlayGroup);
      this.stlOverlayGroup = null;
    }
    if (!triangleZone) {
      return;
    }
    const session = this.surfaceZonePainting.getSession(sessionId);
    const zones: readonly SurfaceZoneOverlayZone[] = session?.voxelZones ?? [];
    const group = buildSurfaceZoneOverlay(stlMesh, triangleZone, zones, 1);
    group.visible = false;
    this.zonePainting.activeSource()!.scene.add(group);
    this.stlOverlayGroup = group;
  }

  private resizeVoxelIfNeeded(canvas: HTMLCanvasElement): void {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (width === 0 || height === 0 || (this.voxelLastSize.width === width && this.voxelLastSize.height === height)) {
      return;
    }
    this.voxelLastSize.width = width;
    this.voxelLastSize.height = height;
    const aspect = width / height;
    const halfHeight = this.voxelFramingRadius * 1.15;
    this.voxelCamera.left = -halfHeight * aspect;
    this.voxelCamera.right = halfHeight * aspect;
    this.voxelCamera.top = halfHeight;
    this.voxelCamera.bottom = -halfHeight;
    this.voxelCamera.updateProjectionMatrix();
    this.voxelRenderer!.setSize(width, height);
    this.voxelOit!.setSize(width, height);
  }

  private resizeStlIfNeeded(canvas: HTMLCanvasElement): void {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (width === 0 || height === 0 || (this.stlLastSize.width === width && this.stlLastSize.height === height)) {
      return;
    }
    this.stlLastSize.width = width;
    this.stlLastSize.height = height;
    const aspect = width / height;
    const halfHeight = this.stlFramingRadius * 1.15;
    this.stlCamera.left = -halfHeight * aspect;
    this.stlCamera.right = halfHeight * aspect;
    this.stlCamera.top = halfHeight;
    this.stlCamera.bottom = -halfHeight;
    this.stlCamera.updateProjectionMatrix();
    this.stlRenderer!.setSize(width, height);
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    if (!this.viewReady) {
      return;
    }
    if (!this.hasActiveSession()) {
      // The canvases are *ngIf-gated on this same condition, so they're
      // already gone (or about to be) - free whatever this component still
      // holds itself (renderer/controls/context) in step.
      this.teardownVoxelRenderer();
      this.teardownStlRenderer();
      return;
    }
    if (this.isHidden()) {
      // Only covered by a wizard step - skip rendering this frame, but
      // deliberately do NOT tear anything down: the canvases are still
      // there, still worth keeping warm for when the wizard step closes
      // again, which happens far too often per session to pay a full
      // context create/destroy for every time.
      return;
    }
    const sessionId = this.zonePainting.activeSessionId();
    const source = this.zonePainting.activeSource();
    const voxelCanvas = this.voxelCanvasRef?.nativeElement;
    const stlCanvas = this.stlCanvasRef?.nativeElement;
    if (sessionId === null || !source || !voxelCanvas) {
      return;
    }

    // --- Voxel panel - literally ZonePaintingComponent's own result panel:
    // same scene, same hiddenDuringView fixtures hidden, the STL reference
    // left visible (step 1's own result panel shows it too, for comparing
    // fit), zone overlay shown only during this render. ---
    if (this.ensureVoxelRenderer(voxelCanvas)) {
      if (sessionId !== this.lastVoxelSessionId) {
        this.lastVoxelSessionId = sessionId;
        this.rebuildVoxelFraming(source);
      }
      this.rebuildVoxelOverlay(sessionId);
      this.resizeVoxelIfNeeded(voxelCanvas);
      // Cheap in-place update, every frame, deliberately NOT gated behind
      // zonesRevision like rebuildVoxelOverlay's own full rebuild -
      // setZoneOverlayOpacity (the SERVICE method, changing a slider) never
      // bumps zonesRevision, so a rebuild-only approach silently never
      // picked up an opacity change at all. Matches
      // ZonePaintingComponent.setZoneOverlayOpacityFromInput's own
      // "mutate the existing mesh's material directly" idiom.
      if (this.voxelOverlayGroup) {
        setZoneOverlayOpacity(this.voxelOverlayGroup, this.zonePainting.getZoneOverlayOpacity(sessionId));
      }

      const previousVisibility = source.hiddenDuringView.map(object => object.visible);
      source.hiddenDuringView.forEach(object => (object.visible = false));
      if (this.voxelOverlayGroup) {
        this.voxelOverlayGroup.visible = true;
      }
      try {
        this.voxelControls!.update();
        this.webglBudget.touch('zone-preview-voxel');
        this.voxelOit!.render(source.scene, this.voxelCamera);
      } finally {
        source.hiddenDuringView.forEach((object, i) => (object.visible = previousVisibility[i]));
        if (this.voxelOverlayGroup) {
          this.voxelOverlayGroup.visible = false;
        }
      }
    }

    // --- STL panel - literally SurfaceZonePaintingComponent's own result
    // panel: same scene, additionally hides the voxel preview (step 2's own
    // hand-off does the same), swaps the plain STL mesh for the colored
    // overlay once zone data exists. ---
    if (source.stlMesh && stlCanvas) {
      if (this.ensureStlRenderer(stlCanvas)) {
        if (source.stlMesh !== this.lastStlMesh) {
          this.lastStlMesh = source.stlMesh;
          this.rebuildStlFraming(source.stlMesh);
        }
        this.rebuildStlOverlay(sessionId, source.stlMesh);
        this.resizeStlIfNeeded(stlCanvas);

        const previousVisibility = source.hiddenDuringView.map(object => object.visible);
        source.hiddenDuringView.forEach(object => (object.visible = false));
        const voxelPreviewWasVisible = source.voxelPreview.visible;
        source.voxelPreview.visible = false;
        const stlMeshWasVisible = source.stlMesh.visible;
        const showingResult = this.stlOverlayGroup !== null;
        source.stlMesh.visible = stlMeshWasVisible && !showingResult;
        if (this.stlOverlayGroup) {
          this.stlOverlayGroup.visible = true;
        }
        try {
          this.stlControls!.update();
          this.webglBudget.touch('zone-preview-stl');
          this.stlRenderer!.render(source.scene, this.stlCamera);
        } finally {
          source.hiddenDuringView.forEach((object, i) => (object.visible = previousVisibility[i]));
          source.voxelPreview.visible = voxelPreviewWasVisible;
          source.stlMesh.visible = stlMeshWasVisible;
          if (this.stlOverlayGroup) {
            this.stlOverlayGroup.visible = false;
          }
        }
      }
    } else {
      this.teardownStlRenderer();
    }
  };
}
