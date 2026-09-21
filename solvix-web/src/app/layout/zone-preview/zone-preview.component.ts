import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ZonePaintingService, ZonePaintingSource } from '../../state/zone-painting.service';
import { SurfaceZonePaintingService } from '../../state/surface-zone-painting.service';
import { VoxelizationService } from '../../state/voxelization.service';
import { buildZoneOverlayGroup, disposeZoneOverlayGroup, setZoneOverlayOpacity } from '../../geometry/scene-objects/zone-overlay';
import { SurfaceZoneOverlayZone, buildSurfaceZoneOverlay, disposeSurfaceZoneOverlay } from '../../geometry/scene-objects/surface-zone-overlay';
import { WeightedOitRenderer } from '../../rendering/weighted-oit';

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
  imports: [NgIf],
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

  private frameId = 0;
  private viewReady = false;

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

  // Frontmost only while the LIST itself is on screen - both wizard steps
  // (z-index 1100) draw fully on top of this (999) and of the list (1000)
  // alike, so there is no point spending GPU time on either panel while
  // they're up.
  isHidden(): boolean {
    return (
      this.zonePainting.activeSessionId() === null || this.zonePainting.step1Visible() || this.surfaceZonePainting.activeSessionId() !== null
    );
  }

  hasStlReference(): boolean {
    return this.zonePainting.activeSource()?.stlMesh != null;
  }

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
    this.voxelRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.voxelRenderer.setPixelRatio(window.devicePixelRatio);
    this.voxelOit = new WeightedOitRenderer(this.voxelRenderer);
    this.voxelControls = new OrbitControls(this.voxelCamera, canvas);
    this.voxelControls.screenSpacePanning = true;
    this.voxelControls.enableDamping = false;
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
    this.stlRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.stlRenderer.setPixelRatio(window.devicePixelRatio);
    this.stlControls = new OrbitControls(this.stlCamera, canvas);
    this.stlControls.screenSpacePanning = true;
    this.stlControls.enableDamping = false;
    this.stlLastSize.width = 0;
    this.stlLastSize.height = 0;
    return true;
  }

  private teardownVoxelRenderer(): void {
    if (!this.voxelRenderer) {
      return;
    }
    this.voxelControls?.dispose();
    this.voxelOit?.dispose();
    this.voxelRenderer.dispose();
    this.voxelRenderer = null;
    this.voxelOit = null;
    this.voxelControls = null;
  }

  private teardownStlRenderer(): void {
    if (!this.stlRenderer) {
      return;
    }
    this.stlControls?.dispose();
    this.stlRenderer.dispose();
    this.stlRenderer = null;
    this.stlControls = null;
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
    if (!this.viewReady || this.isHidden()) {
      this.teardownVoxelRenderer();
      this.teardownStlRenderer();
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
