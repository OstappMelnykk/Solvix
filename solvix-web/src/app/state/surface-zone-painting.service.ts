import { Injectable, inject, signal } from '@angular/core';
import * as THREE from 'three';
import { ZonePaintingService, Axis, AXES, axisCoords, projectedCoords } from './zone-painting.service';
import { ImportedReferenceRenderService } from './imported-reference-render.service';
import { isSingleConnectedComponent } from './mask-connectivity';
import { buildSurfaceShellGrid, assignTriangleZones } from '../geometry/surface-shell-grid';
import { VoxelGridDto, countOccupied, isOccupied } from '../geometry/voxel-grid-contract';

// The second, later step of Проблема 2 Варіант D (docs/local-refinement/
// PROBLEMS.md): once the voxel zones are painted AND explicitly saved
// (ZonePaintingService.save), each of those zones must ALSO be tied to its
// OWN patch of the actual STL surface - otherwise a zone's boundary
// vertices could isoparametric-snap onto a NEIGHBORING zone's surface
// instead of their own, self-intersecting the element (see PROBLEMS.md's
// isoparametric-mapping example). This paints that correspondence on a
// second, much finer grid built directly over the STL triangles
// (geometry/surface-shell-grid.ts) using the exact same 3-axis mask-
// painting/connectivity mechanics as the voxel tool - see
// ZonePaintingService for the shared reasoning behind that mechanism.
//
// Differs from the voxel tool in 3 ways, all per the user's explicit
// request:
// 1. A committed selection here does NOT create a new zone - it's
//    committed into whichever EXISTING voxel zone the user picked from a
//    list before painting (setActiveVoxelZoneId). One voxel zone can
//    receive multiple separate committed selections (e.g. a thin root's
//    front and back surface, physically disjoint but the same logical
//    zone) - this is exactly why pairing can't just be "1st STL selection
//    = 1st voxel zone" by creation order alone.
// 2. Completion requires BOTH full coverage (no unassigned occupied shell
//    cell left) AND every voxel zone actually used at least once - not the
//    voxel tool's "partial coverage is fine, unassigned falls back to
//    Варіант B" rule.
// 3. Opens as an explicit separate step, only once the voxel zoning itself
//    is ZonePaintingService.isSaved() - the whole reason to run this at all
//    is to pin down a surface patch for each ALREADY-DECIDED voxel zone.

export interface SurfaceZonePaintingSource {
  readonly scene: THREE.Scene;
  // The actual displayed STL reference object - geometry/surface-shell-grid.ts
  // builds the fine grid directly from its triangles (baked through its own
  // matrixWorld, same as geometry/mesh-contract.ts's toMeshBinary), and the
  // component raycasts against it directly (no BatchedMesh instance ids to
  // resolve, unlike the voxel tool - a raycast hit's own world-space point
  // is all that's needed to find a shell cell).
  readonly stlMesh: THREE.Object3D;
  readonly framingObjects: readonly THREE.Object3D[];
  readonly hiddenDuringView: readonly THREE.Object3D[];
}

export interface SurfaceZoneOption {
  readonly voxelZoneId: number;
  readonly color: string;
}

export type SurfaceZoneCellState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'zoned'; readonly color: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'excluded' }
  | { readonly kind: 'available' };

interface SurfacePaintingSession {
  readonly grid: VoxelGridDto; // the fine shell grid, not the solid voxel grid
  readonly totalOccupied: number;
  readonly voxelZones: readonly SurfaceZoneOption[]; // snapshot of the voxel session's zones at open() time
  // -1 = unassigned, else one of voxelZones' own voxelZoneId - deliberately
  // NOT a separate id space (see the file header's point 1): a shell cell
  // belongs directly to a voxel zone, with no extra indirection table.
  readonly cellZone: Int16Array;
  // Running total of assigned cells - kept incrementally (finishSelection)
  // rather than rescanned, same reasoning as ZonePaintingService's own
  // zones[].reduce (cheap because it never needs a full grid scan).
  assignedCount: number;
  readonly usedVoxelZoneIds: Set<number>;
  activeVoxelZoneId: number;
  saved: boolean;
  // Computed once, in save() - which zone (a voxelZoneId, or -1) each STL
  // triangle belongs to. This is the actual "dictionary" a downstream
  // refinement pass would read: given a triangle, which zone's boundary it
  // may snap to.
  triangleZone: Int16Array | null;
  readonly maskX: Uint8Array;
  readonly maskY: Uint8Array;
  readonly maskZ: Uint8Array;
}

function shellIndex(grid: VoxelGridDto, ix: number, iy: number, iz: number): number {
  return ix + iy * grid.countX + iz * grid.countX * grid.countY;
}

function maskFor(session: SurfacePaintingSession, axis: Axis): Uint8Array {
  return axis === 'x' ? session.maskX : axis === 'y' ? session.maskY : session.maskZ;
}

function maskDims(grid: VoxelGridDto, axis: Axis): { width: number; height: number } {
  if (axis === 'x') {
    return { width: grid.countY, height: grid.countZ };
  }
  if (axis === 'y') {
    return { width: grid.countX, height: grid.countZ };
  }
  return { width: grid.countX, height: grid.countY };
}

function maskIndex(grid: VoxelGridDto, axis: Axis, u: number, v: number): number {
  const { width } = maskDims(grid, axis);
  return u + v * width;
}

// Single shared instance, same reasoning as ZonePaintingService/
// SixViewOverlayService - only one of these windows can ever be open.
@Injectable({ providedIn: 'root' })
export class SurfaceZonePaintingService {
  private readonly zonePainting = inject(ZonePaintingService);
  private readonly referenceRender = inject(ImportedReferenceRenderService);

  readonly activeSessionId = signal<number | null>(null);
  readonly activeSource = signal<SurfaceZonePaintingSource | null>(null);

  private readonly sessionsByKey = new Map<number, SurfacePaintingSession>();

  constructor() {
    // Same reasoning as ZonePaintingService's own subscription - once the
    // STL geometry this session's shell grid was built from is gone
    // (rotate/move/reimport), the grid's world-space alignment with the
    // CURRENT mesh is no longer valid.
    this.referenceRender.referenceChanged$.subscribe(sessionId => this.discardSession(sessionId));
  }

  private discardSession(sessionId: number): void {
    if (!this.sessionsByKey.has(sessionId)) {
      return;
    }
    this.sessionsByKey.delete(sessionId);
    if (this.activeSessionId() === sessionId) {
      this.close();
    }
  }

  // Opens the window for `sessionId` - refuses unless the voxel zoning is
  // both successful AND explicitly saved (see the file header's point 3).
  // Rebuilds the shell grid + a fresh session whenever the voxel zone LIST
  // itself has changed since the last time this was open (same "grid
  // identity changed -> fresh session" rule as ZonePaintingService.open) -
  // comparing zone ids, since resetZones/further painting on the voxel side
  // would otherwise leave this pointing at zones that no longer exist.
  open(sessionId: number, source: SurfaceZonePaintingSource): boolean {
    if (!this.zonePainting.isSaved(sessionId)) {
      return false;
    }
    const voxelSession = this.zonePainting.getSession(sessionId);
    if (!voxelSession || voxelSession.zones.length === 0) {
      return false;
    }
    const voxelZoneIds = voxelSession.zones.map(zone => zone.id);
    const existing = this.sessionsByKey.get(sessionId);
    const alreadyMatches = existing && existing.voxelZones.map(zone => zone.voxelZoneId).join(',') === voxelZoneIds.join(',');
    if (!alreadyMatches) {
      const grid = buildSurfaceShellGrid(source.stlMesh, voxelSession.grid);
      const voxelZones = voxelSession.zones.map(zone => ({ voxelZoneId: zone.id, color: zone.color }));
      this.sessionsByKey.set(sessionId, this.createSession(grid, voxelZones));
    }
    this.activeSource.set(source);
    this.activeSessionId.set(sessionId);
    return true;
  }

  close(): void {
    this.activeSessionId.set(null);
    this.activeSource.set(null);
  }

  private createSession(grid: VoxelGridDto, voxelZones: readonly SurfaceZoneOption[]): SurfacePaintingSession {
    return {
      grid,
      totalOccupied: countOccupied(grid),
      voxelZones,
      cellZone: new Int16Array(grid.countX * grid.countY * grid.countZ).fill(-1),
      assignedCount: 0,
      usedVoxelZoneIds: new Set(),
      activeVoxelZoneId: voxelZones[0].voxelZoneId,
      saved: false,
      triangleZone: null,
      maskX: new Uint8Array(grid.countY * grid.countZ),
      maskY: new Uint8Array(grid.countX * grid.countZ),
      maskZ: new Uint8Array(grid.countX * grid.countY)
    };
  }

  getSession(sessionId: number): { readonly grid: VoxelGridDto; readonly voxelZones: readonly SurfaceZoneOption[] } | null {
    const session = this.sessionsByKey.get(sessionId);
    return session ? { grid: session.grid, voxelZones: session.voxelZones } : null;
  }

  getActiveVoxelZoneId(sessionId: number): number | null {
    return this.sessionsByKey.get(sessionId)?.activeVoxelZoneId ?? null;
  }

  // Which EXISTING voxel zone the next finishSelection() call commits the
  // pending mask into - picked explicitly by the user (a dropdown/list of
  // the voxel zones), never inferred, since one voxel zone can rightfully
  // receive more than one separate STL selection (file header point 1).
  setActiveVoxelZoneId(sessionId: number, voxelZoneId: number): void {
    const session = this.sessionsByKey.get(sessionId);
    if (session && session.voxelZones.some(zone => zone.voxelZoneId === voxelZoneId)) {
      session.activeVoxelZoneId = voxelZoneId;
    }
  }

  // "assigned" is every shell cell already committed to some zone -
  // "total" is every shell cell the STL surface actually touches. Unlike
  // ZonePaintingService's own coverage, reaching assigned === total is a
  // REQUIREMENT here (see save()), not just an informational stat.
  coverage(sessionId: number): { readonly assigned: number; readonly total: number } | null {
    const session = this.sessionsByKey.get(sessionId);
    return session ? { assigned: session.assignedCount, total: session.totalOccupied } : null;
  }

  // True once every voxel zone this session started with has received at
  // least one committed selection - the other half of save()'s
  // requirement, alongside full coverage.
  allVoxelZonesUsed(sessionId: number): boolean {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return false;
    }
    return session.voxelZones.every(zone => session.usedVoxelZoneIds.has(zone.voxelZoneId));
  }

  isSaved(sessionId: number): boolean {
    return this.sessionsByKey.get(sessionId)?.saved ?? false;
  }

  // Computes the actual triangle -> zone assignment (geometry/surface-
  // shell-grid.ts's assignTriangleZones) and freezes the session - refuses
  // (same defensive backstop as ZonePaintingService.save) unless coverage
  // is complete AND every voxel zone was used, even though the component
  // itself already gates the button on both.
  save(sessionId: number, stlMesh: THREE.Object3D): boolean {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return false;
    }
    if (session.assignedCount < session.totalOccupied || !this.allVoxelZonesUsed(sessionId)) {
      return false;
    }
    session.triangleZone = assignTriangleZones(stlMesh, session.grid, (ix, iy, iz) => this.zoneIdAt(sessionId, ix, iy, iz));
    session.saved = true;
    return true;
  }

  // The final "dictionary" a downstream refinement pass reads - which
  // zone (a voxelZoneId, or null) triangle `triangleIndex` belongs to.
  // null until save() has actually run.
  zoneIdOfTriangle(sessionId: number, triangleIndex: number): number | null {
    const zoneId = this.sessionsByKey.get(sessionId)?.triangleZone?.[triangleIndex];
    return zoneId === undefined || zoneId === -1 ? null : zoneId;
  }

  // The raw array behind zoneIdOfTriangle - for a caller building a colored
  // overlay over every triangle at once (SurfaceZonePaintingComponent's own
  // result panel, WorldCanvasComponent's "Показати зони на STL" button),
  // reading it directly is simpler and cheaper than looping
  // zoneIdOfTriangle one call per triangle. null until save() has run.
  getTriangleZones(sessionId: number): Int16Array | null {
    return this.sessionsByKey.get(sessionId)?.triangleZone ?? null;
  }

  // Wipes every committed assignment AND whatever's pending - the "Скинути
  // розмітку STL" button, same reasoning/shape as ZonePaintingService's own
  // resetZones (reuses createSession rather than clearing fields by hand).
  resetSelections(sessionId: number): void {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return;
    }
    this.sessionsByKey.set(sessionId, this.createSession(session.grid, session.voxelZones));
  }

  toggleCell(sessionId: number, axis: Axis, u: number, v: number): boolean {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return false;
    }
    const mask = maskFor(session, axis);
    const { width, height } = maskDims(session.grid, axis);
    if (u < 0 || u >= width || v < 0 || v >= height) {
      return false;
    }
    const index = maskIndex(session.grid, axis, u, v);
    const previous = mask[index];
    if (!previous && !this.isCellAvailable(session, axis, u, v)) {
      return false;
    }
    mask[index] = previous ? 0 : 1;
    if (!isSingleConnectedComponent(mask, width, height)) {
      mask[index] = previous;
      return false;
    }
    return true;
  }

  selectRect(sessionId: number, axis: Axis, u0: number, v0: number, u1: number, v1: number): boolean {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return false;
    }
    const mask = maskFor(session, axis);
    const { width, height } = maskDims(session.grid, axis);
    const minU = Math.max(0, Math.min(u0, u1));
    const maxU = Math.min(width - 1, Math.max(u0, u1));
    const minV = Math.max(0, Math.min(v0, v1));
    const maxV = Math.min(height - 1, Math.max(v0, v1));

    const [axisA, axisB] = AXES.filter(a => a !== axis);
    const maskA = maskFor(session, axisA);
    const maskB = maskFor(session, axisB);
    const maskAHasAny = maskA.includes(1);
    const maskBHasAny = maskB.includes(1);

    const previous = mask.slice();
    let addedAny = false;
    for (let v = minV; v <= maxV; v++) {
      for (let u = minU; u <= maxU; u++) {
        if (mask[u + v * width]) {
          continue;
        }
        const state = this.classifyCell(session, axis, u, v, mask, maskA, maskAHasAny, maskB, maskBHasAny, axisA, axisB);
        if (state.kind === 'available') {
          mask[u + v * width] = 1;
          addedAny = true;
        }
      }
    }
    if (!addedAny) {
      return false;
    }
    if (!isSingleConnectedComponent(mask, width, height)) {
      mask.set(previous);
      return false;
    }
    return true;
  }

  private isCellAvailable(session: SurfacePaintingSession, axis: Axis, u: number, v: number): boolean {
    const ownMask = maskFor(session, axis);
    const [axisA, axisB] = AXES.filter(a => a !== axis);
    const maskA = maskFor(session, axisA);
    const maskB = maskFor(session, axisB);
    const state = this.classifyCell(session, axis, u, v, ownMask, maskA, maskA.includes(1), maskB, maskB.includes(1), axisA, axisB);
    return state.kind === 'available';
  }

  pendingMask(sessionId: number, axis: Axis): Uint8Array | null {
    const session = this.sessionsByKey.get(sessionId);
    return session ? maskFor(session, axis) : null;
  }

  viewState(sessionId: number, axis: Axis): { width: number; height: number; cells: SurfaceZoneCellState[] } {
    const session = this.sessionsByKey.get(sessionId);
    const emptyResult = { width: 0, height: 0, cells: [] };
    if (!session) {
      return emptyResult;
    }
    const { grid } = session;
    const { width, height } = maskDims(grid, axis);
    const ownMask = maskFor(session, axis);
    const [otherAxisA, otherAxisB] = AXES.filter(a => a !== axis);
    const maskA = maskFor(session, otherAxisA);
    const maskB = maskFor(session, otherAxisB);
    const maskAHasAny = maskA.includes(1);
    const maskBHasAny = maskB.includes(1);

    const cells: SurfaceZoneCellState[] = new Array(width * height);
    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        cells[u + v * width] = this.classifyCell(session, axis, u, v, ownMask, maskA, maskAHasAny, maskB, maskBHasAny, otherAxisA, otherAxisB);
      }
    }
    return { width, height, cells };
  }

  private classifyCell(
    session: SurfacePaintingSession,
    axis: Axis,
    u: number,
    v: number,
    ownMask: Uint8Array,
    maskA: Uint8Array,
    maskAHasAny: boolean,
    maskB: Uint8Array,
    maskBHasAny: boolean,
    axisA: Axis,
    axisB: Axis
  ): SurfaceZoneCellState {
    const { grid, cellZone } = session;
    const thirdCount = axis === 'x' ? grid.countX : axis === 'y' ? grid.countY : grid.countZ;

    let sawOccupiedAny = false;
    let sawOccupiedUnassigned = false;
    let zoneColorIfAnyClaimed: string | null = null;
    for (let t = 0; t < thirdCount; t++) {
      const { ix, iy, iz } = axisCoords(axis, t, u, v);
      if (!isOccupied(grid, ix, iy, iz)) {
        continue;
      }
      sawOccupiedAny = true;
      const zoneId = cellZone[shellIndex(grid, ix, iy, iz)];
      if (zoneId !== -1) {
        zoneColorIfAnyClaimed ??= session.voxelZones.find(zone => zone.voxelZoneId === zoneId)?.color ?? null;
        continue;
      }
      const coordsA = projectedCoords(axisA, ix, iy, iz);
      const coordsB = projectedCoords(axisB, ix, iy, iz);
      const aOk = !maskAHasAny || maskA[coordsA.u + coordsA.v * maskDims(grid, axisA).width] === 1;
      const bOk = !maskBHasAny || maskB[coordsB.u + coordsB.v * maskDims(grid, axisB).width] === 1;
      if (aOk && bOk) {
        sawOccupiedUnassigned = true;
      }
    }

    if (ownMask[u + v * maskDims(grid, axis).width]) {
      return { kind: 'pending' };
    }
    if (sawOccupiedUnassigned) {
      return { kind: 'available' };
    }
    if (zoneColorIfAnyClaimed) {
      return { kind: 'zoned', color: zoneColorIfAnyClaimed };
    }
    return sawOccupiedAny ? { kind: 'excluded' } : { kind: 'empty' };
  }

  // Commits the pending selection (intersection of the 3 masks) into
  // `session.activeVoxelZoneId` - unlike ZonePaintingService.finishZone,
  // this never creates a new zone id, and can be called more than once for
  // the same voxelZoneId (file header point 1). Returns how many cells
  // actually got assigned.
  finishSelection(sessionId: number): number {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return 0;
    }
    const { grid, maskX, maskY, maskZ, cellZone, activeVoxelZoneId } = session;
    const maskXHasAny = maskX.includes(1);
    const maskYHasAny = maskY.includes(1);
    const maskZHasAny = maskZ.includes(1);
    let assigned = 0;
    for (let iz = 0; iz < grid.countZ; iz++) {
      for (let iy = 0; iy < grid.countY; iy++) {
        for (let ix = 0; ix < grid.countX; ix++) {
          const index = shellIndex(grid, ix, iy, iz);
          if (cellZone[index] !== -1 || !isOccupied(grid, ix, iy, iz)) {
            continue;
          }
          const xOk = !maskXHasAny || maskX[iy + iz * grid.countY] === 1;
          const yOk = !maskYHasAny || maskY[ix + iz * grid.countX] === 1;
          const zOk = !maskZHasAny || maskZ[ix + iy * grid.countX] === 1;
          if (xOk && yOk && zOk) {
            cellZone[index] = activeVoxelZoneId;
            assigned++;
          }
        }
      }
    }
    if (assigned > 0) {
      session.assignedCount += assigned;
      session.usedVoxelZoneIds.add(activeVoxelZoneId);
      maskX.fill(0);
      maskY.fill(0);
      maskZ.fill(0);
    }
    return assigned;
  }

  zoneIdAt(sessionId: number, ix: number, iy: number, iz: number): number | null {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return null;
    }
    const zoneId = session.cellZone[shellIndex(session.grid, ix, iy, iz)];
    return zoneId === -1 ? null : zoneId;
  }
}
