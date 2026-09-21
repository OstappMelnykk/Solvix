import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ZonePaintingService } from '../../state/zone-painting.service';
import { SurfaceZonePaintingService } from '../../state/surface-zone-painting.service';
import { ImportedReferenceRenderService } from '../../state/imported-reference-render.service';
import { VoxelGridDto } from '../../geometry/voxel-grid-contract';
import { buildVoxelBasePreview, disposeVoxelBasePreview } from '../../geometry/scene-objects/voxel-base-preview';
import { ZoneOverlayZone, buildZoneOverlayGroup, disposeZoneOverlayGroup } from '../../geometry/scene-objects/zone-overlay';
import { SurfaceZoneOverlayZone, buildSurfaceZoneOverlay, disposeSurfaceZoneOverlay } from '../../geometry/scene-objects/surface-zone-overlay';

// Fully opaque, deliberately independent of ZonePaintingService's own
// zoneOverlayOpacity slider (that one is for the interactive editing views,
// which need to see the model through the color) - this is a passive,
// at-a-glance preview, where a crisp solid color reads better at the small
// size these 2 panels actually render at.
const OVERLAY_OPACITY = 1;

// A separate, globally-mounted overlay (app.component.html), NOT nested
// inside ZoneListComponent's own template - 2 reasons: (1) ZoneListComponent
// explicitly keeps NO 3D rendering of its own (its own header comment), and
// (2) ZoneListComponent already has an extensive spec file that creates a
// fresh instance per test; nesting a real WebGL-rendering child there would
// mean 30+ real WebGLRenderer create/destroy cycles per test run for
// nothing those tests actually exercise - matching this codebase's existing
// convention of never writing a .spec.ts for a component with a live
// requestAnimationFrame render loop (ZonePaintingComponent/
// SurfaceZonePaintingComponent/SixViewOverlayComponent/WorldCanvasComponent
// have none either).
//
// Visually combined with ZoneListComponent purely through z-index stacking:
// this sits BEHIND it (z-index 999 vs. 1000), full-screen, and
// ZoneListComponent's own header + right-hand column are the only opaque
// parts of ITS OWN template - the list's left half is simply left empty (no
// element there at all, see its own .scss), so this preview shows through
// untouched in exactly that region with no pixel-coordinate duplication
// between the two components' stylesheets.
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
  private readonly referenceRender = inject(ImportedReferenceRenderService);

  private frameId = 0;
  private viewReady = false;

  // --- Top panel: painted voxels, white base ------------------------------
  private voxelRenderer: THREE.WebGLRenderer | null = null;
  private readonly voxelScene = new THREE.Scene();
  private readonly voxelCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  private voxelControls: OrbitControls | null = null;
  private voxelBaseMesh: THREE.Group | null = null;
  private voxelOverlayGroup: THREE.Group | null = null;
  private lastVoxelGrid: VoxelGridDto | null = null;
  private lastVoxelRevision = -1;
  private readonly voxelLastSize = { width: 0, height: 0 };
  private readonly voxelFramingCenter = new THREE.Vector3();
  private voxelFramingRadius = 1;

  // --- Bottom panel: painted STL surface -----------------------------------
  private stlRenderer: THREE.WebGLRenderer | null = null;
  private readonly stlScene = new THREE.Scene();
  private readonly stlCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  private stlControls: OrbitControls | null = null;
  private stlOverlayGroup: THREE.Object3D | null = null;
  private lastStlMesh: THREE.Object3D | null = null;
  private lastTriangleZone: Int16Array | null = null;
  private readonly stlLastSize = { width: 0, height: 0 };
  private readonly stlFramingCenter = new THREE.Vector3();
  private stlFramingRadius = 1;

  constructor() {
    // Both buildVoxelBasePreview's fill and buildSurfaceZoneOverlay's mesh
    // use a lit MeshStandardMaterial (matching the real editing views'
    // own technique - see each builder's own header comment) - without a
    // light either renders pure black regardless of vertex color.
    this.voxelScene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const voxelDirectional = new THREE.DirectionalLight(0xffffff, 0.9);
    voxelDirectional.position.set(1, 1, 1);
    this.voxelScene.add(voxelDirectional);

    this.stlScene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const stlDirectional = new THREE.DirectionalLight(0xffffff, 0.9);
    stlDirectional.position.set(1, 1, 1);
    this.stlScene.add(stlDirectional);
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.animate();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frameId);
    this.teardownVoxelRenderer();
    this.teardownStlRenderer();
    if (this.voxelBaseMesh) {
      disposeVoxelBasePreview(this.voxelBaseMesh);
    }
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
  // they're up; the same "hidden means stop rendering entirely" discipline
  // every other overlay tool in this app already follows.
  isHidden(): boolean {
    return (
      this.zonePainting.activeSessionId() === null || this.zonePainting.step1Visible() || this.surfaceZonePainting.activeSessionId() !== null
    );
  }

  hasStlReference(): boolean {
    const sessionId = this.zonePainting.activeSessionId();
    return sessionId !== null && this.referenceRender.getScaledReference(sessionId) !== null;
  }

  private ensureVoxelRenderer(canvas: HTMLCanvasElement): boolean {
    if (this.voxelRenderer) {
      return true;
    }
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return false;
    }
    this.voxelRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.voxelRenderer.setPixelRatio(window.devicePixelRatio);
    this.voxelRenderer.setClearColor(0x000000, 1);
    this.voxelControls = new OrbitControls(this.voxelCamera, canvas);
    this.configureTurntable(this.voxelControls);
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
    this.stlRenderer.setClearColor(0x000000, 1);
    this.stlControls = new OrbitControls(this.stlCamera, canvas);
    this.configureTurntable(this.stlControls);
    this.stlLastSize.width = 0;
    this.stlLastSize.height = 0;
    return true;
  }

  // A passive, always-spinning turntable - no manual interaction (this is a
  // small glance-at-it preview, not an inspection tool; the wizard's own
  // "3D результат" panel already covers manual orbiting).
  private configureTurntable(controls: OrbitControls): void {
    controls.enableRotate = false;
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 4;
  }

  private teardownVoxelRenderer(): void {
    if (!this.voxelRenderer) {
      return;
    }
    this.voxelControls?.dispose();
    this.voxelRenderer.dispose();
    this.voxelRenderer = null;
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

  // Rebuilds only what actually changed: the base mesh only when the grid
  // itself is a new object (a fresh voxelization), the colored overlay only
  // when zonesRevision moved (a zone was added/edited/deleted) - matches
  // ZonePaintingComponent's own "rebuild on identity/revision change, not
  // every frame" discipline.
  private rebuildVoxelPanel(sessionId: number): void {
    const session = this.zonePainting.getSession(sessionId);
    if (!session) {
      return;
    }
    if (session.grid !== this.lastVoxelGrid) {
      this.lastVoxelGrid = session.grid;
      if (this.voxelBaseMesh) {
        this.voxelScene.remove(this.voxelBaseMesh);
        disposeVoxelBasePreview(this.voxelBaseMesh);
        this.voxelBaseMesh = null;
      }
      const base = buildVoxelBasePreview(session.grid);
      if (base) {
        this.voxelScene.add(base);
        this.voxelBaseMesh = base;
      }
      const box = this.voxelBaseMesh ? new THREE.Box3().setFromObject(this.voxelBaseMesh) : new THREE.Box3();
      const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
      this.voxelFramingCenter.copy(sphere.center);
      this.voxelFramingRadius = Math.max(sphere.radius, 0.01);
      if (this.voxelControls) {
        this.applyFraming(this.voxelCamera, this.voxelControls, this.voxelFramingCenter, this.voxelFramingRadius, this.voxelCanvasRef?.nativeElement);
      }
    }

    const revision = this.zonePainting.zonesRevision(sessionId);
    if (revision !== this.lastVoxelRevision) {
      this.lastVoxelRevision = revision;
      if (this.voxelOverlayGroup) {
        this.voxelScene.remove(this.voxelOverlayGroup);
        disposeZoneOverlayGroup(this.voxelOverlayGroup);
        this.voxelOverlayGroup = null;
      }
      const zones: readonly ZoneOverlayZone[] = session.zones;
      const group = buildZoneOverlayGroup(session.grid, zones, (ix, iy, iz) => this.zonePainting.zoneIdAt(sessionId, ix, iy, iz), OVERLAY_OPACITY);
      if (group) {
        this.voxelScene.add(group);
        this.voxelOverlayGroup = group;
      }
    }
  }

  private rebuildStlPanel(sessionId: number): void {
    const stlMesh = this.referenceRender.getScaledReference(sessionId);
    const triangleZone = this.surfaceZonePainting.getTriangleZones(sessionId);
    if (stlMesh === this.lastStlMesh && triangleZone === this.lastTriangleZone) {
      return;
    }
    const meshChanged = stlMesh !== this.lastStlMesh;
    this.lastStlMesh = stlMesh;
    this.lastTriangleZone = triangleZone;

    if (this.stlOverlayGroup) {
      this.stlScene.remove(this.stlOverlayGroup);
      disposeSurfaceZoneOverlay(this.stlOverlayGroup);
      this.stlOverlayGroup = null;
    }
    if (!stlMesh) {
      return;
    }
    const zones: readonly SurfaceZoneOverlayZone[] = this.surfaceZonePainting.getSession(sessionId)?.voxelZones ?? [];
    // An empty Int16Array reads as -1 (fallback gray) at every triangle
    // index - buildSurfaceZoneOverlay's own `triangleZone[i] ?? -1` already
    // handles a typed array's out-of-range read that way, so this alone
    // covers "no STL zone session exists yet" with no separate code path.
    const group = buildSurfaceZoneOverlay(stlMesh, triangleZone ?? new Int16Array(0), zones, OVERLAY_OPACITY);
    this.stlScene.add(group);
    this.stlOverlayGroup = group;

    if (meshChanged) {
      const box = new THREE.Box3().setFromObject(group);
      const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
      this.stlFramingCenter.copy(sphere.center);
      this.stlFramingRadius = Math.max(sphere.radius, 0.01);
      if (this.stlControls) {
        this.applyFraming(this.stlCamera, this.stlControls, this.stlFramingCenter, this.stlFramingRadius, this.stlCanvasRef?.nativeElement);
      }
    }
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
    const voxelCanvas = this.voxelCanvasRef?.nativeElement;
    const stlCanvas = this.stlCanvasRef?.nativeElement;
    if (sessionId === null || !voxelCanvas) {
      return;
    }

    if (this.ensureVoxelRenderer(voxelCanvas)) {
      this.rebuildVoxelPanel(sessionId);
      this.resizeVoxelIfNeeded(voxelCanvas);
      this.voxelControls!.update();
      this.voxelRenderer!.render(this.voxelScene, this.voxelCamera);
    }

    if (this.hasStlReference() && stlCanvas) {
      if (this.ensureStlRenderer(stlCanvas)) {
        this.rebuildStlPanel(sessionId);
        this.resizeStlIfNeeded(stlCanvas);
        this.stlControls!.update();
        this.stlRenderer!.render(this.stlScene, this.stlCamera);
      }
    } else {
      this.teardownStlRenderer();
    }
  };
}
