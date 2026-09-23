import * as THREE from 'three';
import { CORNER_OFFSETS, VoxelCell } from './voxel-cell';
import { VoxelGridDto, isOccupied } from './voxel-grid-contract';

// Smooths long, roughly-uniform stretches of voxels (a pipe, a shaft, a
// tapering root) from a jagged unit-cube staircase into a visually
// continuous, gently tapering shape - WITHOUT changing how many elements
// exist. Per docs/IDEAS.md R4, every World shows the SAME topology (same
// cell count, same cells individually selectable/refinable) - only how
// each cell's own corners are POSITIONED differs per World. Ideal World
// never calls this at all (its cells stay perfect unit cubes, since local
// refinement T1-T4 needs that); Real World does, purely as a rendering
// pass on cells ALREADY built via buildVoxelCells(grid) - same mutate-
// shared-corners-in-place pattern surface-projection.ts's snap uses.
//
// The cross-section is allowed to gradually narrow or widen along a run
// (see TAPER_MAX_SLOPE below) - each reshaped cell becomes a (slightly)
// trapezoidal prism instead of a perfect cube, and adjacent cells in the
// same run always agree on their shared face's position (both derive it
// from the SAME linear interpolation between the run's start and end
// cross-section, keyed only by that face's own position along the run -
// never from either cell's own individual shape), so there's never a seam.
export interface VoxelReshapeResult {
  readonly reshapedCellCount: number;
}

// Half-angle a run's side walls may deviate from parallel, expressed as a
// lattice-unit drift per unit step along the run's own axis - e.g. a
// rectangle edge may move by at most ~0.268 cells per slice, accumulated
// over the whole run's length from its starting slice (so a short run can
// barely taper at all, while a long one can taper significantly, always
// staying within a 15 degree cone).
const TAPER_MAX_SLOPE = Math.tan((15 * Math.PI) / 180);

const AXES = [0, 1, 2] as const;
type Axis = (typeof AXES)[number];

// Lattice-index bounds (INCLUSIVE, cell coordinates) of a cross-section
// rectangle in the 2 axes perpendicular to whichever axis is currently
// being walked.
interface Rect {
  readonly bMin: number;
  readonly bMax: number;
  readonly cMin: number;
  readonly cMax: number;
}

function rectArea(rect: Rect): number {
  return (rect.bMax - rect.bMin + 1) * (rect.cMax - rect.cMin + 1);
}

function cellKey(ix: number, iy: number, iz: number, countX: number, countY: number): number {
  return ix + iy * countX + iz * countX * countY;
}

// Maps (axis, sliceIndex, b, c) - a position within the 2D cross-section
// perpendicular to `axis` - to real (ix,iy,iz) grid coordinates. `b`
// always refers to the lower-numbered of the two remaining axes, `c` to
// the higher one (axis=0 -> b is Y, c is Z; axis=1 -> b is X, c is Z;
// axis=2 -> b is X, c is Y) - an arbitrary but fixed convention, consistent
// between every function below.
function realCoord(axis: Axis, sliceIndex: number, b: number, c: number): [number, number, number] {
  if (axis === 0) {
    return [sliceIndex, b, c];
  }
  if (axis === 1) {
    return [b, sliceIndex, c];
  }
  return [b, c, sliceIndex];
}

// Which world coordinate (x/y/z) a run-relative role maps onto for a given
// axis - 'axis' is the run's own direction, 'b'/'c' the same convention as
// realCoord above. Used to know which single component of a THREE.Vector3
// corner to mutate.
function worldAxisFor(axis: Axis, role: 'axis' | 'b' | 'c'): 'x' | 'y' | 'z' {
  if (axis === 0) {
    return role === 'axis' ? 'x' : role === 'b' ? 'y' : 'z';
  }
  if (axis === 1) {
    return role === 'axis' ? 'y' : role === 'b' ? 'x' : 'z';
  }
  return role === 'axis' ? 'z' : role === 'b' ? 'x' : 'y';
}

function setLatticeCoord(corner: THREE.Vector3, grid: VoxelGridDto, worldAxis: 'x' | 'y' | 'z', latticeValue: number): void {
  if (worldAxis === 'x') {
    corner.x = grid.origin.x + grid.cellSize * latticeValue;
  } else if (worldAxis === 'y') {
    corner.y = grid.origin.y + grid.cellSize * latticeValue;
  } else {
    corner.z = grid.origin.z + grid.cellSize * latticeValue;
  }
}

function crossSectionDims(grid: VoxelGridDto, axis: Axis): { dimAxis: number; dimB: number; dimC: number } {
  if (axis === 0) {
    return { dimAxis: grid.countX, dimB: grid.countY, dimC: grid.countZ };
  }
  if (axis === 1) {
    return { dimAxis: grid.countY, dimB: grid.countX, dimC: grid.countZ };
  }
  return { dimAxis: grid.countZ, dimB: grid.countX, dimC: grid.countY };
}

function isFree(grid: VoxelGridDto, claimed: Uint8Array, axis: Axis, sliceIndex: number, b: number, c: number, dimB: number, dimC: number): boolean {
  if (b < 0 || b >= dimB || c < 0 || c >= dimC) {
    return false;
  }
  const [ix, iy, iz] = realCoord(axis, sliceIndex, b, c);
  if (!isOccupied(grid, ix, iy, iz)) {
    return false;
  }
  return claimed[cellKey(ix, iy, iz, grid.countX, grid.countY)] === 0;
}

// Flood-fills the connected (4-neighbor), unclaimed, occupied region of
// the cross-section at `sliceIndex` containing (startB,startC), and
// reports it ONLY if that region is an exact filled rectangle (its cell
// count equals its own bounding box's area) - a circular, notched, or
// branching cross-section returns null, which is exactly what should stop
// a run there: this file only ever reshapes a region it can describe as a
// straight-edged (tapering) tube, never one it would have to guess at.
function rectComponentAt(
  grid: VoxelGridDto,
  claimed: Uint8Array,
  axis: Axis,
  sliceIndex: number,
  dimB: number,
  dimC: number,
  startB: number,
  startC: number
): Rect | null {
  if (!isFree(grid, claimed, axis, sliceIndex, startB, startC, dimB, dimC)) {
    return null;
  }
  const visited = new Set<number>();
  const startKey = startB * dimC + startC;
  visited.add(startKey);
  const stack: [number, number][] = [[startB, startC]];
  let bMin = startB;
  let bMax = startB;
  let cMin = startC;
  let cMax = startC;
  let count = 0;

  while (stack.length > 0) {
    const [b, c] = stack.pop()!;
    count++;
    bMin = Math.min(bMin, b);
    bMax = Math.max(bMax, b);
    cMin = Math.min(cMin, c);
    cMax = Math.max(cMax, c);
    for (const [db, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1]
    ] as const) {
      const nb = b + db;
      const nc = c + dc;
      const key = nb * dimC + nc;
      if (visited.has(key) || !isFree(grid, claimed, axis, sliceIndex, nb, nc, dimB, dimC)) {
        continue;
      }
      visited.add(key);
      stack.push([nb, nc]);
    }
  }

  const rect = { bMin, bMax, cMin, cMax };
  return count === rectArea(rect) ? rect : null;
}

// Whether `rect`, found `distance` slices away from the run's starting
// slice, still sits within the run's allowed taper cone relative to
// `startRect` - every one of the rectangle's 4 edges may drift by at most
// TAPER_MAX_SLOPE per slice of distance, accumulated (not per adjacent
// step), so the resulting taper's overall half-angle never exceeds ~15
// degrees no matter how many slices the run spans.
function withinTaper(rect: Rect, startRect: Rect, distance: number): boolean {
  const maxDrift = TAPER_MAX_SLOPE * distance + 1e-6;
  return (
    Math.abs(rect.bMin - startRect.bMin) <= maxDrift &&
    Math.abs(rect.bMax - startRect.bMax) <= maxDrift &&
    Math.abs(rect.cMin - startRect.cMin) <= maxDrift &&
    Math.abs(rect.cMax - startRect.cMax) <= maxDrift
  );
}

interface Run {
  readonly lo: number;
  readonly hi: number;
  readonly loRect: Rect;
  readonly hiRect: Rect;
  // Every slice's own TRUE (unmodified) rect across [lo,hi], in order -
  // reshapeRun needs this to know exactly which of each cell's corners
  // actually sit on the run's boundary (and so need repositioning), as
  // opposed to an interior corner of a wider cross-section.
  readonly rectsByIx: readonly Rect[];
  readonly totalCells: number;
}

// Extends outward from (startIx, startRect) in both directions along
// `axis` while each next slice's cross-section is still an exact
// rectangle (rectComponentAt) and still within taper tolerance of the
// start (withinTaper). Reseeds each step from the PREVIOUS slice's own
// rect center - taper is gradual, so the center barely moves between
// adjacent slices, making it a safe way to find "the same" region rather
// than accidentally jumping to an unrelated rectangle elsewhere in the
// cross-section.
function extendRun(grid: VoxelGridDto, claimed: Uint8Array, axis: Axis, dimAxis: number, dimB: number, dimC: number, startIx: number, startRect: Rect): Run {
  const rectsByIx = new Map<number, Rect>([[startIx, startRect]]);

  let lo = startIx;
  let loRect = startRect;
  for (let ix = startIx - 1; ix >= 0; ix--) {
    const seedB = Math.round((loRect.bMin + loRect.bMax) / 2);
    const seedC = Math.round((loRect.cMin + loRect.cMax) / 2);
    const rect = rectComponentAt(grid, claimed, axis, ix, dimB, dimC, seedB, seedC);
    if (!rect || !withinTaper(rect, startRect, startIx - ix)) {
      break;
    }
    lo = ix;
    loRect = rect;
    rectsByIx.set(ix, rect);
  }

  let hi = startIx;
  let hiRect = startRect;
  for (let ix = startIx + 1; ix < dimAxis; ix++) {
    const seedB = Math.round((hiRect.bMin + hiRect.bMax) / 2);
    const seedC = Math.round((hiRect.cMin + hiRect.cMax) / 2);
    const rect = rectComponentAt(grid, claimed, axis, ix, dimB, dimC, seedB, seedC);
    if (!rect || !withinTaper(rect, startRect, ix - startIx)) {
      break;
    }
    hi = ix;
    hiRect = rect;
    rectsByIx.set(ix, rect);
  }

  const rects: Rect[] = [];
  let totalCells = 0;
  for (let ix = lo; ix <= hi; ix++) {
    const rect = rectsByIx.get(ix)!;
    rects.push(rect);
    totalCells += rectArea(rect);
  }

  return { lo, hi, loRect, hiRect, rectsByIx: rects, totalCells };
}

function claimRun(grid: VoxelGridDto, claimed: Uint8Array, axis: Axis, run: Run): void {
  for (let offset = 0; offset < run.rectsByIx.length; offset++) {
    const ix = run.lo + offset;
    const rect = run.rectsByIx[offset];
    for (let b = rect.bMin; b <= rect.bMax; b++) {
      for (let c = rect.cMin; c <= rect.cMax; c++) {
        const [rix, riy, riz] = realCoord(axis, ix, b, c);
        claimed[cellKey(rix, riy, riz, grid.countX, grid.countY)] = 1;
      }
    }
  }
}

// Linear interpolation of a corner-space bound (e.g. bMin, or bMax+1) at
// axis-position `axisPos` (ranging over the run's own CORNER lattice, from
// `lo` to `hi+1` inclusive) between the run's start and end cross-section.
function lerpBound(loValue: number, hiValue: number, lo: number, hi: number, axisPos: number): number {
  const span = hi + 1 - lo;
  return span === 0 ? loValue : loValue + (hiValue - loValue) * ((axisPos - lo) / span);
}

// Repositions the corners of every cell in `run` that sit on its tapering
// boundary - leaves the run's cell COUNT and every interior (non-boundary)
// corner untouched, only moving the corner along whichever of the 2
// cross-section axes (b and/or c) it's a wall on, and only by however much
// the linear taper between the run's start/end cross-section says it
// should move at that corner's own position along the run. A corner
// shared between 2 adjacent cells in the run (buildVoxelCells already
// hands them the SAME Vector3 instance) is computed identically regardless
// of which cell "owns" it - a pure function of (run, axisPos, b/c role) -
// so adjacent cells' shared face is always exactly consistent, no seam.
function reshapeRun(grid: VoxelGridDto, cellByKey: ReadonlyMap<number, VoxelCell>, axis: Axis, run: Run): number {
  const bWorldAxis = worldAxisFor(axis, 'b');
  const cWorldAxis = worldAxisFor(axis, 'c');
  let reshapedCount = 0;

  for (let offset = 0; offset < run.rectsByIx.length; offset++) {
    const p = run.lo + offset;
    const trueRect = run.rectsByIx[offset];
    for (let b = trueRect.bMin; b <= trueRect.bMax; b++) {
      for (let c = trueRect.cMin; c <= trueRect.cMax; c++) {
        const [ix, iy, iz] = realCoord(axis, p, b, c);
        const cell = cellByKey.get(cellKey(ix, iy, iz, grid.countX, grid.countY));
        if (!cell) {
          continue;
        }
        const atBMinWall = b === trueRect.bMin;
        const atBMaxWall = b === trueRect.bMax;
        const atCMinWall = c === trueRect.cMin;
        const atCMaxWall = c === trueRect.cMax;
        if (!atBMinWall && !atBMaxWall && !atCMinWall && !atCMaxWall) {
          continue; // interior of a wide cross-section - nothing to reshape
        }

        CORNER_OFFSETS.forEach(([dx, dy, dz], cornerIndex) => {
          const axisBit = axis === 0 ? dx : axis === 1 ? dy : dz;
          const bBit = axis === 0 ? dy : dx;
          const cBit = axis === 0 || axis === 1 ? dz : dy;
          const axisPos = p + axisBit;
          const onBWall = (bBit === 0 && atBMinWall) || (bBit === 1 && atBMaxWall);
          const onCWall = (cBit === 0 && atCMinWall) || (cBit === 1 && atCMaxWall);
          if (!onBWall && !onCWall) {
            return;
          }
          const corner = cell.corners[cornerIndex];
          if (onBWall) {
            const loBound = bBit === 0 ? run.loRect.bMin : run.loRect.bMax + 1;
            const hiBound = bBit === 0 ? run.hiRect.bMin : run.hiRect.bMax + 1;
            setLatticeCoord(corner, grid, bWorldAxis, lerpBound(loBound, hiBound, run.lo, run.hi, axisPos));
          }
          if (onCWall) {
            const loBound = cBit === 0 ? run.loRect.cMin : run.loRect.cMax + 1;
            const hiBound = cBit === 0 ? run.hiRect.cMin : run.hiRect.cMax + 1;
            setLatticeCoord(corner, grid, cWorldAxis, lerpBound(loBound, hiBound, run.lo, run.hi, axisPos));
          }
        });
        reshapedCount++;
      }
    }
  }

  return reshapedCount;
}

// Real World's entry point - mutates `cells`' own corner Vector3 instances
// IN PLACE (same pattern as surface-projection.ts's snap), never adds or
// removes a cell. `cells` must already be built via buildVoxelCells(grid)
// (same grid). Returns how many cells were actually reshaped, for a status
// message - 0 if nothing in the model has an elongated, tolerance-fitting
// run at all.
export function reshapeElongatedVoxels(cells: readonly VoxelCell[], grid: VoxelGridDto): VoxelReshapeResult {
  const cellByKey = new Map<number, VoxelCell>();
  for (const cell of cells) {
    cellByKey.set(cellKey(cell.ix, cell.iy, cell.iz, grid.countX, grid.countY), cell);
  }
  const claimed = new Uint8Array(grid.countX * grid.countY * grid.countZ);
  let reshapedCellCount = 0;

  for (const cell of cells) {
    const key = cellKey(cell.ix, cell.iy, cell.iz, grid.countX, grid.countY);
    if (claimed[key] !== 0) {
      continue;
    }

    let bestAxis: Axis | null = null;
    let bestRun: Run | null = null;
    for (const axis of AXES) {
      const { dimAxis, dimB, dimC } = crossSectionDims(grid, axis);
      const [sliceIndex, b, c] = axis === 0 ? [cell.ix, cell.iy, cell.iz] : axis === 1 ? [cell.iy, cell.ix, cell.iz] : [cell.iz, cell.ix, cell.iy];
      const startRect = rectComponentAt(grid, claimed, axis, sliceIndex, dimB, dimC, b, c);
      if (!startRect) {
        continue;
      }
      const run = extendRun(grid, claimed, axis, dimAxis, dimB, dimC, sliceIndex, startRect);
      // Requires the run to actually span 2+ slices along this axis - a
      // rectangle found at only the seed's own slice isn't elongated at
      // all (that's a flat patch, not a pipe/root).
      if (run.hi > run.lo && (!bestRun || run.totalCells > bestRun.totalCells)) {
        bestAxis = axis;
        bestRun = run;
      }
    }

    if (bestAxis === null || !bestRun) {
      claimed[key] = 1;
      continue;
    }

    claimRun(grid, claimed, bestAxis, bestRun);
    reshapedCellCount += reshapeRun(grid, cellByKey, bestAxis, bestRun);
  }

  return { reshapedCellCount };
}
