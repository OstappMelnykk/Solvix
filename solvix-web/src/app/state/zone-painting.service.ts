import { Injectable, effect, inject, signal } from '@angular/core';
import * as THREE from 'three';
import { SessionsService } from './sessions.service';
import { VoxelizationService } from './voxelization.service';
import { VoxelGridDto, countOccupied, isOccupied } from '../geometry/voxel-grid-contract';

// What WorldCanvasComponent.openZonePainting hands the service to open the
// window - same shape/reasoning as SixViewOverlayService's own SixViewSource
// (the REAL Scene, not a clone, so the 6 panels show exactly what the Ideal
// World shows), plus `voxelPreview` specifically so the component can
// raycast against the actual voxel BatchedMesh (same object
// handleVoxelPointerUp already raycasts against for click-to-select) to
// resolve a click to a real (ix,iy,iz), not just a flat screen position.
export interface ZonePaintingSource {
  readonly scene: THREE.Scene;
  readonly voxelPreview: THREE.Object3D;
  readonly framingObjects: readonly THREE.Object3D[];
  readonly hiddenDuringView: readonly THREE.Object3D[];
}

// docs/local-refinement/PROBLEMS.md, Проблема 2, Варіант D - manual
// alternative/complement to the automatic connectivity check (Варіант B):
// the user paints axis-aligned "zones" over the ALREADY voxelized grid by
// selecting a 2D area on each of 3 fixed orthogonal views (one per axis -
// see AXES below), and the intersection of those 3 areas becomes one zone.
// Voxels the user never zones stay unassigned and fall back to Варіант B's
// automatic check - this service never requires full coverage.

export type Axis = 'x' | 'y' | 'z';
export const AXES: readonly Axis[] = ['x', 'y', 'z'];

// Palette a new zone's color is drawn from, cycling if there are more zones
// than colors - distinct enough at a glance, no meaning beyond "which zone".
const ZONE_COLORS: readonly string[] = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#8338ec', '#ffbe0b', '#06d6a0', '#ef476f'];

export interface ZoneDefinition {
  readonly id: number;
  readonly color: string;
  // How many voxels this zone claimed at the moment it was committed -
  // fixed forever after (a zone's voxels are never reassigned or removed
  // once committed), so this is set once in finishZone and never recomputed.
  readonly voxelCount: number;
}

// What a cell on one of the 3 views renders as - purely a display/interaction
// classification, never stored: recomputed on demand from the grid, the
// zone assignment, and the OTHER 2 axes' pending masks (see viewState).
export type ZoneCellState =
  | { readonly kind: 'empty' } // no occupied voxel maps to this cell at all
  | { readonly kind: 'zoned'; readonly color: string } // already committed to a finished zone - not selectable
  | { readonly kind: 'pending' } // part of the CURRENT (uncommitted) zone's mask on THIS axis
  | { readonly kind: 'excluded' } // unclaimed, but the other 2 views' current masks already rule out every voxel this cell could contribute
  | { readonly kind: 'available' }; // unclaimed and still reachable - safe to select

// Default for a session's zone-overlay opacity (getZoneOverlayOpacity) - the
// same [0,1] scale a <input type="range"> naturally produces. Deliberately
// NOT the same constant as geometry/zone-overlay.ts's ZONED_ALPHA - that one
// is fixed (the 2D painting panels' 'zoned' cell fill), this one is a
// starting point the user can freely adjust for the two full-3D views.
const DEFAULT_ZONE_OVERLAY_OPACITY = 0.75;

interface PaintingSession {
  readonly grid: VoxelGridDto;
  // Total occupied cells in the grid - computed once at session creation
  // (the grid itself never changes underneath an open painting session),
  // so coverage() can report "assigned / total" without rescanning.
  readonly totalOccupied: number;
  readonly zones: ZoneDefinition[];
  // Bumped on every change to `zones` that a rendered view needs to notice
  // but that DOESN'T change zones.length (currently just setZoneColor) -
  // callers that lazily rebuild a 3D overlay only when something actually
  // changed (WorldCanvasComponent.updateZoneOverlay) key off this instead
  // of zones.length alone, or an in-place color edit would go unnoticed.
  zonesRevision: number;
  // User-adjustable transparency for the 3D colored-zone overlay (the
  // zone-painting window's own result panel, and WorldCanvasComponent's
  // "Показати зони" button) - NOT readonly, since a slider mutates it in
  // place via setZoneOverlayOpacity below. Survives resetZones (see there).
  opacity: number;
  // -1 = unassigned. Same linearization as VoxelGridDto's own occupancy bit
  // index (voxel-grid-contract.ts's cellIndex) - ix fastest, then iy, then iz.
  readonly voxelZone: Int16Array;
  // Pending (uncommitted) 2D masks for the zone currently being drawn - one
  // per axis, over the OTHER two dimensions (see maskIndex).
  readonly maskX: Uint8Array; // over (iy,iz), size countY*countZ
  readonly maskY: Uint8Array; // over (ix,iz), size countX*countZ
  readonly maskZ: Uint8Array; // over (ix,iy), size countX*countY
}

function voxelIndex(grid: VoxelGridDto, ix: number, iy: number, iz: number): number {
  return ix + iy * grid.countX + iz * grid.countX * grid.countY;
}

function maskFor(session: PaintingSession, axis: Axis): Uint8Array {
  return axis === 'x' ? session.maskX : axis === 'y' ? session.maskY : session.maskZ;
}

// (width, height) of the 2D mask for a given axis - width varies fastest,
// matching maskIndex below.
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

// The (u,v) a voxel (ix,iy,iz) projects to on `axis`'s view - inverse of how
// each axis's mask is indexed above.
// (u,v) on `axis`'s view -> a REPRESENTATIVE (ix,iy,iz) at that column (t
// picks where along the collapsed axis - any occupied t works: what the
// component draws is an orthographic-projected 2D overlay, and orthographic
// projection has no parallax, so every t along one column lands on the exact
// same screen position regardless of which one is picked).
export function axisCoords(axis: Axis, t: number, u: number, v: number): { ix: number; iy: number; iz: number } {
  if (axis === 'x') {
    return { ix: t, iy: u, iz: v };
  }
  if (axis === 'y') {
    return { ix: u, iy: t, iz: v };
  }
  return { ix: u, iy: v, iz: t };
}

// (ix,iy,iz) -> that voxel's (u,v) on `axis`'s view - what the component
// feeds a raycast hit's cell through, so a click on the REAL rendered voxel
// resolves to the right 2D cell to toggle/select.
export function projectedCoords(axis: Axis, ix: number, iy: number, iz: number): { u: number; v: number } {
  if (axis === 'x') {
    return { u: iy, v: iz };
  }
  if (axis === 'y') {
    return { u: ix, v: iz };
  }
  return { u: ix, v: iy };
}

// 4-connectivity flood fill - is every SET cell in `mask` reachable from
// every other SET cell? An empty mask counts as connected (nothing to
// disconnect yet), matching how "no selection" isn't itself a violation of
// GEOMETRY_RULES.md-style connectivity rules elsewhere in this codebase.
function isSingleConnectedComponent(mask: Uint8Array, width: number, height: number): boolean {
  const start = mask.indexOf(1);
  if (start === -1) {
    return true;
  }
  const visited = new Uint8Array(mask.length);
  visited[start] = 1;
  let visitedCount = 1;
  let total = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      total++;
    }
  }
  const stack = [start];
  while (stack.length > 0) {
    const index = stack.pop()!;
    const u = index % width;
    const v = (index / width) | 0;
    const neighbors: [number, number][] = [
      [u + 1, v],
      [u - 1, v],
      [u, v + 1],
      [u, v - 1]
    ];
    for (const [nu, nv] of neighbors) {
      if (nu < 0 || nu >= width || nv < 0 || nv >= height) {
        continue;
      }
      const nIndex = nu + nv * width;
      if (mask[nIndex] && !visited[nIndex]) {
        visited[nIndex] = 1;
        visitedCount++;
        stack.push(nIndex);
      }
    }
  }
  return visitedCount === total;
}

// Single shared instance, same reasoning as SixViewOverlayService - only one
// zone-painting window can ever be open at a time, driven by whichever
// WorldCanvasComponent's button opened it.
@Injectable({ providedIn: 'root' })
export class ZonePaintingService {
  private readonly sessions = inject(SessionsService);
  private readonly voxelization = inject(VoxelizationService);

  // Non-null means the painting window should be showing, for this session,
  // rendering `activeSource`'s REAL scene (same reasoning as
  // SixViewOverlayService.active). Direction per axis is display-only (which
  // side the user finds easier to see the relevant area from) - it never
  // changes which voxels a view's mask reaches, so it isn't tracked here at
  // all, only in the component.
  readonly activeSessionId = signal<number | null>(null);
  readonly activeSource = signal<ZonePaintingSource | null>(null);

  private readonly sessionsByKey = new Map<number, PaintingSession>();

  constructor() {
    effect(() => {
      const ids = new Set(this.sessions.sessions().map(session => session.id));
      for (const key of [...this.sessionsByKey.keys()]) {
        if (!ids.has(key)) {
          this.sessionsByKey.delete(key);
        }
      }
      if (this.activeSessionId() !== null && !ids.has(this.activeSessionId()!)) {
        this.close();
      }
    });
  }

  // Opens the window for `sessionId`, provided its voxelization succeeded.
  // Re-opening after new voxels were added/removed resets all zone data -
  // a previous painting session's (ix,iy,iz) assignments have no reliable
  // meaning once the grid's own shape (and so its index linearization) has
  // changed underneath them.
  open(sessionId: number, source: ZonePaintingSource): void {
    const status = this.voxelization.getStatus(sessionId);
    if (status.kind !== 'ok') {
      return;
    }
    const existing = this.sessionsByKey.get(sessionId);
    if (!existing || existing.grid !== status.result) {
      this.sessionsByKey.set(sessionId, this.createSession(status.result));
    }
    this.activeSource.set(source);
    this.activeSessionId.set(sessionId);
  }

  close(): void {
    this.activeSessionId.set(null);
    this.activeSource.set(null);
  }

  private createSession(grid: VoxelGridDto): PaintingSession {
    const voxelZone = new Int16Array(grid.countX * grid.countY * grid.countZ).fill(-1);
    return {
      grid,
      totalOccupied: countOccupied(grid),
      zones: [],
      zonesRevision: 0,
      opacity: DEFAULT_ZONE_OVERLAY_OPACITY,
      voxelZone,
      maskX: new Uint8Array(grid.countY * grid.countZ),
      maskY: new Uint8Array(grid.countX * grid.countZ),
      maskZ: new Uint8Array(grid.countX * grid.countY)
    };
  }

  getSession(sessionId: number): { readonly grid: VoxelGridDto; readonly zones: readonly ZoneDefinition[] } | null {
    const session = this.sessionsByKey.get(sessionId);
    return session ? { grid: session.grid, zones: session.zones } : null;
  }

  // See PaintingSession.zonesRevision's own comment - a cache key for
  // callers that only want to rebuild a rendered zone overlay when
  // something in `zones` actually changed.
  zonesRevision(sessionId: number): number {
    return this.sessionsByKey.get(sessionId)?.zonesRevision ?? -1;
  }

  // Lets the user override a committed zone's auto-assigned color (a
  // <input type="color"> next to it in the zone list) - purely cosmetic,
  // never touches which voxels belong to the zone.
  setZoneColor(sessionId: number, zoneId: number, color: string): void {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return;
    }
    const index = session.zones.findIndex(zone => zone.id === zoneId);
    if (index === -1) {
      return;
    }
    session.zones[index] = { ...session.zones[index], color };
    session.zonesRevision++;
  }

  getZoneOverlayOpacity(sessionId: number): number {
    return this.sessionsByKey.get(sessionId)?.opacity ?? DEFAULT_ZONE_OVERLAY_OPACITY;
  }

  setZoneOverlayOpacity(sessionId: number, opacity: number): void {
    const session = this.sessionsByKey.get(sessionId);
    if (session) {
      session.opacity = Math.min(1, Math.max(0, opacity));
    }
  }

  // Wipes every committed zone AND whatever's currently pending, back to
  // the same blank slate open() starts from - the "скинути всі зони" button.
  // Reuses createSession rather than clearing each field in place, so this
  // can never drift out of sync with what a fresh session actually looks
  // like.
  resetZones(sessionId: number): void {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return;
    }
    // Opacity is a display preference, not zone data - carried over rather
    // than reset back to the default along with everything else. Revision
    // is carried forward INCREMENTED, not reset to 0, so a cache keyed on
    // (sessionId, revision) elsewhere can't mistake the wiped session for
    // whatever it had already cached under the same sessionId + revision 0.
    const next = this.createSession(session.grid);
    next.opacity = session.opacity;
    next.zonesRevision = session.zonesRevision + 1;
    this.sessionsByKey.set(sessionId, next);
  }

  // "assigned" is the sum of every committed zone's own voxelCount (each
  // zone's voxels are fixed forever once committed, so this never needs to
  // rescan the grid) - "total" is every occupied cell, zoned or not.
  // assigned === total (and > 0) means there's nothing left to zone.
  coverage(sessionId: number): { readonly assigned: number; readonly total: number } | null {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return null;
    }
    const assigned = session.zones.reduce((sum, zone) => sum + zone.voxelCount, 0);
    return { assigned, total: session.totalOccupied };
  }

  // The color the NEXT committed zone will get - shown while the user is
  // still drawing it, before finishZone makes it official.
  nextZoneColor(sessionId: number): string {
    const session = this.sessionsByKey.get(sessionId);
    const count = session?.zones.length ?? 0;
    return ZONE_COLORS[count % ZONE_COLORS.length];
  }

  // Toggles ONE cell in `axis`'s pending mask. ADDING a cell is refused
  // (no-op, false) unless it currently classifies as 'available' - a cell
  // that's already fully claimed by an earlier zone, or that has no
  // occupied-and-unassigned voxel at all, can never be painted into a new
  // zone (docs/local-refinement/PROBLEMS.md's "вже готові області не можна
  // перемальовувати" requirement). REMOVING a cell (it was already pending)
  // has no such restriction. Either way, the edit is also rejected if it
  // would leave the mask split across 2+ disconnected pieces - "не
  // допускаються розірвані площі".
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

  // Adds every cell in the rectangle [u0,u1]x[v0,v1] (inclusive) that
  // currently classifies as 'available' to `axis`'s pending mask (union with
  // what's already there) - cells already claimed by an earlier zone, or
  // with no occupied-and-unassigned voxel, are silently skipped rather than
  // failing the whole rectangle (dragging a rectangle that merely grazes an
  // old zone should still pick up the free part of it). Rejected as a whole
  // (no partial application) if the result would be disconnected - e.g. the
  // free cells the rectangle actually touched don't form one connected
  // piece, or don't touch the existing selection.
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

    // Hoisted out of the per-cell loop below (same reasoning as viewState's
    // own maskAHasAny/maskBHasAny) - a rectangle can cover thousands of
    // cells, and re-scanning the other 2 axes' masks for every one of them
    // would be needlessly quadratic.
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
    // Nothing in the rectangle was actually addable (every cell in it was
    // already zoned/excluded/empty) - report this the same way a rejected
    // edit is reported, rather than silently succeeding at doing nothing.
    if (!addedAny) {
      return false;
    }
    if (!isSingleConnectedComponent(mask, width, height)) {
      mask.set(previous);
      return false;
    }
    return true;
  }

  // Whether (u,v) on `axis`'s view currently classifies as 'available' -
  // reuses classifyCell's own priority order so "can this be added?" always
  // agrees with what the cell actually renders as, rather than drifting out
  // of sync with a second, separately-maintained rule. Used by toggleCell
  // (a single cell at a time - selectRect hoists the same computation
  // itself, since it runs this over a whole rectangle).
  private isCellAvailable(session: PaintingSession, axis: Axis, u: number, v: number): boolean {
    const ownMask = maskFor(session, axis);
    const [axisA, axisB] = AXES.filter(a => a !== axis);
    const maskA = maskFor(session, axisA);
    const maskB = maskFor(session, axisB);
    const state = this.classifyCell(session, axis, u, v, ownMask, maskA, maskA.includes(1), maskB, maskB.includes(1), axisA, axisB);
    return state.kind === 'available';
  }

  // Read-only snapshot of one axis's pending mask, for the component to draw.
  pendingMask(sessionId: number, axis: Axis): Uint8Array | null {
    const session = this.sessionsByKey.get(sessionId);
    return session ? maskFor(session, axis) : null;
  }

  // Per-cell display classification for one axis's view - see ZoneCellState.
  // Recomputed on demand (not cached/reactive) since it only needs to run
  // once per discrete edit (a click, or a drag's mouseup), never per frame.
  viewState(sessionId: number, axis: Axis): { width: number; height: number; cells: ZoneCellState[] } {
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

    // An axis whose mask is still entirely empty hasn't expressed a
    // constraint yet - treated as "everything passes" on that axis rather
    // than "nothing passes", so painting the FIRST of the 3 views doesn't
    // show as completely blocked just because the other 2 haven't been
    // touched yet. Checked once per view, not per cell.
    const maskAHasAny = maskA.includes(1);
    const maskBHasAny = maskB.includes(1);

    const cells: ZoneCellState[] = new Array(width * height);
    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        cells[u + v * width] = this.classifyCell(session, axis, u, v, ownMask, maskA, maskAHasAny, maskB, maskBHasAny, otherAxisA, otherAxisB);
      }
    }
    return { width, height, cells };
  }

  private classifyCell(
    session: PaintingSession,
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
  ): ZoneCellState {
    const { grid, voxelZone } = session;
    const thirdCount = axis === 'x' ? grid.countX : axis === 'y' ? grid.countY : grid.countZ;

    // Distinguishes 3 reasons "nothing selectable happened here" can occur:
    // sawOccupiedAny false -> truly empty grid space (no voxel at all);
    // sawOccupiedAny true but neither of the below -> occupied, but every
    // voxel here is either already claimed or ruled out by the other 2
    // views (see the priority order below the loop).
    let sawOccupiedAny = false;
    let sawOccupiedUnassigned = false;
    let zoneColorIfAnyClaimed: string | null = null;
    for (let t = 0; t < thirdCount; t++) {
      const { ix, iy, iz } = axisCoords(axis, t, u, v);
      if (!isOccupied(grid, ix, iy, iz)) {
        continue;
      }
      sawOccupiedAny = true;
      const zoneId = voxelZone[voxelIndex(grid, ix, iy, iz)];
      if (zoneId !== -1) {
        zoneColorIfAnyClaimed ??= session.zones[zoneId]?.color ?? null;
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

    // Priority: an explicit pending pick always shows as such, even for a
    // column that also happens to hold already-zoned voxels elsewhere along
    // it - what the user just clicked here is the thing they need to see.
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


  // Commits the current pending selection (intersection of the 3 masks) as
  // a new zone, then clears the pending masks so the next zone starts blank.
  // Returns how many voxels actually got assigned - 0 means the 3 masks'
  // intersection was empty (a caller should warn, not silently accept it as
  // a real zone).
  finishZone(sessionId: number): number {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return 0;
    }
    const { grid, maskX, maskY, maskZ, voxelZone } = session;
    const zoneId = session.zones.length;
    // Same "empty mask = no constraint on that axis" rule as viewState -
    // required for consistency: what looked "available" while painting must
    // actually be included once committed, or the highlighting would lie.
    const maskXHasAny = maskX.includes(1);
    const maskYHasAny = maskY.includes(1);
    const maskZHasAny = maskZ.includes(1);
    let assigned = 0;
    for (let iz = 0; iz < grid.countZ; iz++) {
      for (let iy = 0; iy < grid.countY; iy++) {
        for (let ix = 0; ix < grid.countX; ix++) {
          const index = voxelIndex(grid, ix, iy, iz);
          if (voxelZone[index] !== -1 || !isOccupied(grid, ix, iy, iz)) {
            continue;
          }
          const xOk = !maskXHasAny || maskX[iy + iz * grid.countY] === 1;
          const yOk = !maskYHasAny || maskY[ix + iz * grid.countX] === 1;
          const zOk = !maskZHasAny || maskZ[ix + iy * grid.countX] === 1;
          if (xOk && yOk && zOk) {
            voxelZone[index] = zoneId;
            assigned++;
          }
        }
      }
    }
    // Only an actual commit clears the pending masks - an empty intersection
    // leaves the user's in-progress selection untouched so they can adjust
    // and retry, instead of silently losing it on a failed attempt.
    if (assigned > 0) {
      (session.zones as ZoneDefinition[]).push({ id: zoneId, color: this.nextZoneColor(sessionId), voxelCount: assigned });
      session.zonesRevision++;
      maskX.fill(0);
      maskY.fill(0);
      maskZ.fill(0);
    }
    return assigned;
  }

  // The zone a voxel was manually assigned to, or null if unassigned - the
  // seam Варіант B's automatic check (and, later, the T1/T2/T4 refinement
  // pass) reads to know a zone was manually declared for this voxel.
  zoneIdAt(sessionId: number, ix: number, iy: number, iz: number): number | null {
    const session = this.sessionsByKey.get(sessionId);
    if (!session) {
      return null;
    }
    const zoneId = session.voxelZone[voxelIndex(session.grid, ix, iy, iz)];
    return zoneId === -1 ? null : zoneId;
  }
}