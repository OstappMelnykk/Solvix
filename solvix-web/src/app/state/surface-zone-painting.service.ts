import { Injectable, inject, signal } from '@angular/core';
import * as THREE from 'three';
import { ZonePaintingService, ZonePaintingSource, Axis, AXES, axisCoords, projectedCoords } from './zone-painting.service';
import { ImportedReferenceRenderService } from './imported-reference-render.service';
import { isSingleConnectedComponent } from './mask-connectivity';
import { SHELL_SUBDIVISIONS, buildSurfaceShellGrid, assignTriangleZones } from '../geometry/surface-shell-grid';
import { VoxelGridDto, countOccupied, isOccupied } from '../geometry/voxel-grid-contract';

// The second half of each zone's 2-step wizard (Проблема 2 Варіант D,
// docs/local-refinement/PROBLEMS.md): right after a voxel zone is committed
// (ZonePaintingService.finishZone), it must ALSO be tied to its OWN patch of
// the actual STL surface - otherwise a zone's boundary vertices could
// isoparametric-snap onto a NEIGHBORING zone's surface instead of their own,
// self-intersecting the element (see PROBLEMS.md's isoparametric-mapping
// example). This paints that correspondence on a second, much finer grid
// built directly over the STL triangles (geometry/surface-shell-grid.ts)
// using the exact same 3-axis mask-painting/connectivity mechanics as the
// voxel tool - see ZonePaintingService for the shared reasoning behind that
// mechanism.
//
// Differs from the voxel tool in 3 ways, all per the user's explicit
// request:
// 1. A committed selection here does NOT create a new zone - it's always
//    committed into whichever voxel zone the wizard explicitly set as
//    active (setActiveVoxelZoneId), right before opening this step. One
//    voxel zone can still receive multiple separate committed selections
//    within its own turn (e.g. a thin root's front and back surface,
//    physically disjoint but the same logical zone) - finishSelection can
//    be called any number of times before the wizard moves on.
// 2. Like the voxel tool, partial coverage is fine - an unclaimed shell
//    cell simply has no STL patch recorded for it. Nothing requires every
//    zone to be used or the whole surface covered.
// 3. Opens right after ZonePaintingService.finishZone commits ONE zone (not
//    after the whole voxel zoning is "done" - there's no such moment
//    anymore): the wizard interleaves one zone's voxels, then immediately
//    that same zone's STL patch, before moving to the next zone.

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
  // The ORIGINAL step-1 source, kept verbatim - the "← Крок 1" back button
  // (SurfaceZonePaintingComponent.goToStep1) re-opens ZonePaintingService
  // with this exact object, since it carries fields (voxelPreview,
  // gridHelper/rotateGizmo in hiddenDuringView) this component has no other
  // way to reconstruct on its own.
  readonly step1Source: ZonePaintingSource;
}

// How many shell cells each voxel cell is subdivided into per axis (see
// geometry/surface-shell-grid.ts's own SHELL_SUBDIVISIONS doc comment for
// why this exists at all: a coarse voxel grid can't separate 2 physically
// distinct surface patches sharing one voxel, a finer shell grid can).
// User-adjustable, deliberately with no UI-facing upper bound - the
// component's own number input has no `max`. 1 is the only real floor
// (0 or negative subdivisions can't describe a grid at all).
export const MIN_SHELL_SUBDIVISIONS = 1;
// Not a UI limit (never shown to the user, never bound to the input's `max`)
// - a last-resort safety ceiling purely against the shell grid's own cell
// count (voxel grid cells * subdivisions^3) growing so large it could hang
// or crash the tab from a typo/paste. High enough that it should never
// actually bind during normal use.
const SAFETY_MAX_SHELL_SUBDIVISIONS = 50;
// The actual safety net in practice (open() below) - caps the shell grid's
// total cell count regardless of how big the voxel grid it's built from
// is, rather than one fixed subdivisions ceiling that would be way too
// restrictive for a small grid and still not enough for a huge one. 20M
// cells is a ~2.5MB occupancy bitmask - comfortably safe, not a number the
// user will ever see.
const MAX_TOTAL_SHELL_CELLS = 20_000_000;

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

// finishSelection's own result - see that method's doc comment.
export interface FinishSelectionResult {
  readonly assigned: number;
  readonly disconnected: boolean;
}

interface SurfacePaintingSession {
  readonly grid: VoxelGridDto; // the fine shell grid, not the solid voxel grid
  // The SOLID voxel grid this shell grid was built from - open()'s actual
  // cache key, alongside `subdivisions` (see open()'s own comment for why
  // that's the right key now: rebuilding the shell grid only needs to
  // happen when the underlying geometry or subdivision count changes,
  // never just because a zone was added/deleted).
  readonly voxelGrid: VoxelGridDto;
  // What `subdivisions` was set to when THIS session's grid was built - open()
  // compares this against the CURRENT subdivisions() to decide whether a
  // slider change since the last open means the shell grid needs rebuilding.
  readonly subdivisions: number;
  readonly totalOccupied: number;
  // -1 = unassigned, else a voxelZoneId from ZonePaintingService - deliberately
  // NOT a separate id space (see the file header's point 1): a shell cell
  // belongs directly to a voxel zone, with no extra indirection table.
  readonly cellZone: Int16Array;
  // Running total of assigned cells - kept incrementally (finishSelection/
  // deleteZone) rather than rescanned, same reasoning as ZonePaintingService's
  // own zones[].reduce (cheap because it never needs a full grid scan).
  assignedCount: number;
  readonly usedVoxelZoneIds: Set<number>;
  // Which voxel zone the next finishSelection() commits into - explicitly
  // set by the wizard (setActiveVoxelZoneId) before painting starts for a
  // given zone; -1 until then (nothing paintable yet).
  activeVoxelZoneId: number;
  // Computed fresh after every finishSelection/deleteZone (recomputeTriangleZones) -
  // which zone (a voxelZoneId, or -1) each STL triangle belongs to. This is
  // the actual "dictionary" a downstream refinement pass would read: given a
  // triangle, which zone's boundary it may snap to. null until the first
  // successful commit.
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
  // How finely to subdivide each voxel cell for the shell grid (geometry/
  // surface-shell-grid.ts) - user-adjustable via a slider
  // (ZonePaintingComponent, shown before "Далі: розмітка STL-поверхні"),
  // read fresh by open() below rather than baked in at construction, so
  // dragging the slider before the NEXT open takes effect without needing
  // this service recreated.
  readonly subdivisions = signal(SHELL_SUBDIVISIONS);

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

  // Only floors at MIN_SHELL_SUBDIVISIONS and caps at the internal safety
  // ceiling above (never MAX_SHELL_SUBDIVISIONS - there isn't one) -
  // otherwise takes whatever the user typed, including values open() will
  // later need to itself scale down against the CURRENT voxel grid's own
  // cell count (see open()'s own comment).
  setSubdivisions(value: number): void {
    this.subdivisions.set(Math.min(SAFETY_MAX_SHELL_SUBDIVISIONS, Math.max(MIN_SHELL_SUBDIVISIONS, Math.round(value))));
  }

  // The actual ceiling `subdivisions` gets clamped against for THIS
  // session (open()'s own comment) - exposed so the component can bind it
  // as the number input's real `max` attribute instead of only enforcing
  // it after the fact. Without a bound `max`, the browser's own spinner/
  // scroll increments keep advancing the DISPLAYED value past whatever
  // open() actually clamped `subdivisions` back down to, since Angular's
  // [value] binding skips re-writing the DOM when the bound expression
  // happens to already equal what it last wrote - a real max attribute
  // stops the browser incrementing past it in the first place, so the two
  // can never visibly disagree.
  maxSubdivisionsForSession(sessionId: number): number {
    const voxelSession = this.zonePainting.getSession(sessionId);
    if (!voxelSession) {
      return SAFETY_MAX_SHELL_SUBDIVISIONS;
    }
    return this.maxSubdivisionsForVoxelCellCount(voxelSession.grid.countX * voxelSession.grid.countY * voxelSession.grid.countZ);
  }

  private maxSubdivisionsForVoxelCellCount(voxelCellCount: number): number {
    return Math.max(MIN_SHELL_SUBDIVISIONS, Math.floor(Math.cbrt(MAX_TOTAL_SHELL_CELLS / Math.max(1, voxelCellCount))));
  }

  // Opens the window for `sessionId` - refuses unless at least one voxel
  // zone exists (the wizard only ever opens this right after step 1 commits
  // one, so in practice there always is by the time this is called).
  // Rebuilds the shell grid + a fresh session only when the SOLID voxel
  // grid's own identity has changed (a brand new voxelization run - already
  // invalidated separately via referenceChanged$/discardSession, so this is
  // mostly defensive) or `subdivisions` changed since this session's grid
  // was built - deliberately NOT when the zone list changes: adding or
  // deleting a zone must never wipe previously-painted STL selections for
  // OTHER zones, which a fresh session would do.
  open(sessionId: number, source: SurfaceZonePaintingSource): boolean {
    const voxelSession = this.zonePainting.getSession(sessionId);
    if (!voxelSession || voxelSession.zones.length === 0) {
      return false;
    }
    // The user's requested subdivisions has no fixed ceiling of its own -
    // this is the actual safety net, scaled to what the CURRENT voxel grid
    // can afford rather than one fixed number for every grid: the shell
    // grid's own cell count is voxelCellCount * subdivisions^3, so this
    // caps subdivisions at whatever keeps that product under
    // MAX_TOTAL_SHELL_CELLS regardless of how big or small the voxel grid
    // itself happens to be. Silently lowers `subdivisions` itself (not just
    // what this one open() call uses) so the displayed value never lies
    // about what the grid actually got built with.
    const voxelCellCount = voxelSession.grid.countX * voxelSession.grid.countY * voxelSession.grid.countZ;
    const maxSubdivisionsForGrid = this.maxSubdivisionsForVoxelCellCount(voxelCellCount);
    if (this.subdivisions() > maxSubdivisionsForGrid) {
      this.subdivisions.set(maxSubdivisionsForGrid);
    }
    const subdivisions = this.subdivisions();
    const existing = this.sessionsByKey.get(sessionId);
    const alreadyMatches = existing && existing.subdivisions === subdivisions && existing.voxelGrid === voxelSession.grid;
    if (!alreadyMatches) {
      const grid = buildSurfaceShellGrid(source.stlMesh, voxelSession.grid, subdivisions);
      const fresh = this.createSession(grid, voxelSession.grid, subdivisions);
      this.sessionsByKey.set(sessionId, fresh);
    }
    this.activeSource.set(source);
    this.activeSessionId.set(sessionId);
    return true;
  }

  // Clears whatever's still pending (uncommitted) on the active session
  // before closing - "Закрити"/"← Крок 1" both leave via this without ever
  // calling finishSelection, and this service's own open() reuses the SAME
  // session object on reopen (see its own comment: adding/deleting a zone
  // must not wipe OTHER zones' committed work) - without this, whatever the
  // user brushed but never finished would resurface as already-selected
  // cells the next time this zone (or its renumbered successor) is opened.
  close(): void {
    const sessionId = this.activeSessionId();
    const session = sessionId === null ? undefined : this.sessionsByKey.get(sessionId);
    if (session) {
      session.maskX.fill(0);
      session.maskY.fill(0);
      session.maskZ.fill(0);
    }
    this.activeSessionId.set(null);
    this.activeSource.set(null);
  }

  private createSession(grid: VoxelGridDto, voxelGrid: VoxelGridDto, subdivisions: number): SurfacePaintingSession {
    return {
      grid,
      voxelGrid,
      subdivisions,
      totalOccupied: countOccupied(grid),
      cellZone: new Int16Array(grid.countX * grid.countY * grid.countZ).fill(-1),
      assignedCount: 0,
      usedVoxelZoneIds: new Set(),
      activeVoxelZoneId: -1,
      triangleZone: null,
      maskX: new Uint8Array(grid.countY * grid.countZ),
      maskY: new Uint8Array(grid.countX * grid.countZ),
      maskZ: new Uint8Array(grid.countX * grid.countY)
    };
  }

  // `voxelZones` is computed fresh from ZonePaintingService's OWN current
  // list every call (not cached) - see open()'s own comment on why this
  // service no longer keeps its own snapshot of it.
  getSession(sessionId: number): { readonly grid: VoxelGridDto; readonly voxelZones: readonly SurfaceZoneOption[] } | null {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return null;
    }
    const voxelZones = (this.zonePainting.getSession(sessionId)?.zones ?? []).map(zone => ({ voxelZoneId: zone.id, color: zone.color }));
    return { grid: session.grid, voxelZones };
  }

  getActiveVoxelZoneId(sessionId: number): number | null {
    return this.sessionsByKey.get(sessionId)?.activeVoxelZoneId ?? null;
  }

  // Which voxel zone the next finishSelection() call commits the pending
  // mask into - set explicitly by the wizard right before it opens step 2
  // for a given zone (there is only ever ONE zone being painted per wizard
  // invocation now, no sequence to walk). Refuses an id that isn't one of
  // ZonePaintingService's own current zones.
  setActiveVoxelZoneId(sessionId: number, voxelZoneId: number): void {
    const session = this.sessionsByKey.get(sessionId);
    const voxelZoneExists = this.zonePainting.getSession(sessionId)?.zones.some(zone => zone.id === voxelZoneId) ?? false;
    if (session && voxelZoneExists) {
      session.activeVoxelZoneId = voxelZoneId;
    }
  }

  // Whether `voxelZoneId` has received at least one committed selection yet -
  // the wizard's "Завершити зону" button requires this for the zone it's
  // currently working on before it'll close back to the list.
  isZoneUsed(sessionId: number, voxelZoneId: number): boolean {
    return this.sessionsByKey.get(sessionId)?.usedVoxelZoneIds.has(voxelZoneId) ?? false;
  }

  // How many shell cells `voxelZoneId` currently claims - the zone list's
  // own per-zone STL count, alongside ZonePaintingService's own
  // zones[].voxelCount for the voxel side.
  cellCountForZone(sessionId: number, voxelZoneId: number): number {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return 0;
    }
    let count = 0;
    for (let i = 0; i < session.cellZone.length; i++) {
      if (session.cellZone[i] === voxelZoneId) {
        count++;
      }
    }
    return count;
  }

  // "assigned" is every shell cell already committed to some zone -
  // "total" is every shell cell the STL surface actually touches. Purely
  // informational (the zone list's own STL progress bar) - nothing requires
  // this to ever reach 100%, unclaimed shell cells simply have no STL patch
  // recorded for them.
  coverage(sessionId: number): { readonly assigned: number; readonly total: number } | null {
    const session = this.sessionsByKey.get(sessionId);
    return session ? { assigned: session.assignedCount, total: session.totalOccupied } : null;
  }

  // The final "dictionary" a downstream refinement pass reads - which
  // zone (a voxelZoneId, or null) triangle `triangleIndex` belongs to.
  // null until the first successful finishSelection/deleteZone has run.
  zoneIdOfTriangle(sessionId: number, triangleIndex: number): number | null {
    const zoneId = this.sessionsByKey.get(sessionId)?.triangleZone?.[triangleIndex];
    return zoneId === undefined || zoneId === -1 ? null : zoneId;
  }

  // The raw array behind zoneIdOfTriangle - for a caller building a colored
  // overlay over every triangle at once (SurfaceZonePaintingComponent's own
  // result panel, WorldCanvasComponent's "Показати зони на STL" button),
  // reading it directly is simpler and cheaper than looping
  // zoneIdOfTriangle one call per triangle. null until a commit has run.
  getTriangleZones(sessionId: number): Int16Array | null {
    return this.sessionsByKey.get(sessionId)?.triangleZone ?? null;
  }

  // Recomputes the triangle -> zone dictionary (geometry/surface-shell-grid.ts's
  // assignTriangleZones) from the CURRENT cellZone data - called after every
  // successful finishSelection and deleteZone, so getTriangleZones/
  // zoneIdOfTriangle are always current with no separate "save" step.
  // Needs the actual STL mesh object, which is only guaranteed available
  // through ImportedReferenceRenderService (the tool itself may not be open
  // when deleteZone runs from the zone list) - a no-op if nothing's
  // imported, which can't happen in practice (there's no session to
  // recompute for without one).
  private recomputeTriangleZones(sessionId: number): void {
    const session = this.sessionsByKey.get(sessionId);
    const stlMesh = this.referenceRender.getScaledReference(sessionId);
    if (!session || !stlMesh) {
      return;
    }
    session.triangleZone = assignTriangleZones(stlMesh, session.grid, (ix, iy, iz) => this.zoneIdAt(sessionId, ix, iy, iz));
  }

  // Frees a voxel zone's STL cells back to unassigned and renumbers every
  // zone AFTER it down by 1 - mirrors ZonePaintingService.deleteZone exactly
  // (same voxelZoneId space, so this MUST stay in lockstep with it: a
  // caller deletes a zone by calling both services' deleteZone together,
  // e.g. the zone list's own delete action).
  deleteZone(sessionId: number, voxelZoneId: number): void {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return;
    }
    const { cellZone } = session;
    let removed = 0;
    for (let i = 0; i < cellZone.length; i++) {
      if (cellZone[i] === voxelZoneId) {
        cellZone[i] = -1;
        removed++;
      } else if (cellZone[i] > voxelZoneId) {
        cellZone[i]--;
      }
    }
    session.assignedCount -= removed;
    const renumberedUsed = new Set<number>();
    session.usedVoxelZoneIds.forEach(id => {
      if (id !== voxelZoneId) {
        renumberedUsed.add(id > voxelZoneId ? id - 1 : id);
      }
    });
    session.usedVoxelZoneIds.clear();
    renumberedUsed.forEach(id => session.usedVoxelZoneIds.add(id));
    if (session.activeVoxelZoneId === voxelZoneId) {
      session.activeVoxelZoneId = -1;
    } else if (session.activeVoxelZoneId > voxelZoneId) {
      session.activeVoxelZoneId--;
    }
    this.recomputeTriangleZones(sessionId);
  }

  // Wipes every committed assignment AND whatever's pending - the "Скинути
  // розмітку STL" button, same reasoning/shape as ZonePaintingService's own
  // resetZones (reuses createSession rather than clearing fields by hand).
  resetSelections(sessionId: number): void {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return;
    }
    this.sessionsByKey.set(sessionId, this.createSession(session.grid, session.voxelGrid, session.subdivisions));
  }

  // Connectivity is NOT enforced here (used to be, on every edit) - see
  // finishSelection's own comment for why that moved to commit time
  // instead: it let a user paint 2 separate "islands" and join them later,
  // rather than forcing every intermediate step to already be one
  // connected blob.
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
    if (!previous && !this.isCellAvailable(sessionId, session, axis, u, v)) {
      return false;
    }
    mask[index] = previous ? 0 : 1;
    return true;
  }

  // Connectivity is not enforced here either - see toggleCell's own comment.
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
    const zoneColors = this.currentZoneColors(sessionId);

    let addedAny = false;
    for (let v = minV; v <= maxV; v++) {
      for (let u = minU; u <= maxU; u++) {
        if (mask[u + v * width]) {
          continue;
        }
        const state = this.classifyCell(session, zoneColors, axis, u, v, mask, maskA, maskAHasAny, maskB, maskBHasAny, axisA, axisB);
        if (state.kind === 'available') {
          mask[u + v * width] = 1;
          addedAny = true;
        }
      }
    }
    return addedAny;
  }

  private isCellAvailable(sessionId: number, session: SurfacePaintingSession, axis: Axis, u: number, v: number): boolean {
    const ownMask = maskFor(session, axis);
    const [axisA, axisB] = AXES.filter(a => a !== axis);
    const maskA = maskFor(session, axisA);
    const maskB = maskFor(session, axisB);
    const zoneColors = this.currentZoneColors(sessionId);
    const state = this.classifyCell(session, zoneColors, axis, u, v, ownMask, maskA, maskA.includes(1), maskB, maskB.includes(1), axisA, axisB);
    return state.kind === 'available';
  }

  pendingMask(sessionId: number, axis: Axis): Uint8Array | null {
    const session = this.sessionsByKey.get(sessionId);
    return session ? maskFor(session, axis) : null;
  }

  // A fresh id->color lookup for the CURRENT voxel zone list - built once
  // per call site rather than per cell (viewState/selectRect can classify
  // thousands of cells in one call), same reasoning as maskAHasAny/maskBHasAny
  // being hoisted out of their own per-cell loops.
  private currentZoneColors(sessionId: number): ReadonlyMap<number, string> {
    const zones = this.zonePainting.getSession(sessionId)?.zones ?? [];
    return new Map(zones.map(zone => [zone.id, zone.color]));
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
    const zoneColors = this.currentZoneColors(sessionId);

    const cells: SurfaceZoneCellState[] = new Array(width * height);
    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        cells[u + v * width] = this.classifyCell(session, zoneColors, axis, u, v, ownMask, maskA, maskAHasAny, maskB, maskBHasAny, otherAxisA, otherAxisB);
      }
    }
    return { width, height, cells };
  }

  private classifyCell(
    session: SurfacePaintingSession,
    zoneColors: ReadonlyMap<number, string>,
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
        zoneColorIfAnyClaimed ??= zoneColors.get(zoneId) ?? null;
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
  // the same voxelZoneId (file header point 1). `assigned` is how many
  // cells actually got assigned - 0 means either the intersection was
  // empty, or (`disconnected: true`) at least one of the 3 masks was split
  // into 2+ disconnected pieces. Connectivity is checked HERE, at commit
  // time, not on every intermediate toggleCell/selectRect edit (same
  // reasoning as ZonePaintingService.finishZone's own version of this
  // check) - lets the user build a selection out of disconnected "islands"
  // while painting, as long as it's one connected blob by the time they
  // commit it.
  finishSelection(sessionId: number): FinishSelectionResult {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return { assigned: 0, disconnected: false };
    }
    const { grid, maskX, maskY, maskZ, cellZone, activeVoxelZoneId } = session;
    // -1 means "no zone selected" (createSession's own starting value,
    // restored whenever open() rebuilds the shell grid, e.g. a subdivisions
    // change) - committing here would write -1 into cellZone, which reads
    // back identically to "still unassigned" everywhere else, while
    // assignedCount still went up: a silent mismatch where the overall
    // progress bar counts more than any real zone's own count adds up to.
    if (activeVoxelZoneId === -1) {
      return { assigned: 0, disconnected: false };
    }
    const xDims = maskDims(grid, 'x');
    const yDims = maskDims(grid, 'y');
    const zDims = maskDims(grid, 'z');
    if (
      !isSingleConnectedComponent(maskX, xDims.width, xDims.height) ||
      !isSingleConnectedComponent(maskY, yDims.width, yDims.height) ||
      !isSingleConnectedComponent(maskZ, zDims.width, zDims.height)
    ) {
      return { assigned: 0, disconnected: true };
    }
    const maskXHasAny = maskX.includes(1);
    const maskYHasAny = maskY.includes(1);
    const maskZHasAny = maskZ.includes(1);
    // "An untouched axis is unconstrained" only makes sense when at least
    // ONE axis actually has a selection to intersect against - with all 3
    // empty (nothing painted at all, e.g. clicking "Завершити виділення"
    // before painting anything), every xOk/yOk/zOk below would default to
    // true unconditionally, matching every remaining occupied cell in the
    // ENTIRE shell grid instead of nothing. A real, reproduced bug - console
    // logs below (finishSelection) are there specifically to confirm this
    // was the actual mechanism if it recurs.
    let assigned = 0;
    if (maskXHasAny || maskYHasAny || maskZHasAny) {
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
    }
    if (assigned > 0) {
      session.assignedCount += assigned;
      session.usedVoxelZoneIds.add(activeVoxelZoneId);
      maskX.fill(0);
      maskY.fill(0);
      maskZ.fill(0);
      this.recomputeTriangleZones(sessionId);
    }
    return { assigned, disconnected: false };
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
