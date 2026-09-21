import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

const GRID_SIZE = 50;
const GRID_DIVISIONS = 50;
// Same defaults THREE.GridHelper itself uses (color1/color2) - kept
// identical so swapping the implementation doesn't change how the grid
// actually looks, just how crisply it renders.
const CENTER_LINE_COLOR = new THREE.Color(0x444444);
const GRID_LINE_COLOR = new THREE.Color(0x888888);
// CSS pixels (LineMaterial's `worldUnits` defaults to false) - a constant
// on-screen thickness regardless of zoom/distance from the camera. The
// floor grid used to be a plain THREE.GridHelper (LineSegments + the
// ordinary LineBasicMaterial), whose `linewidth` property is a known
// no-op on almost every browser/GPU combination (a core WebGL limitation,
// not a bug here) - every line effectively renders at a fixed ~1 DEVICE
// pixel no matter how far the camera is, which is exactly why it read as
// thinner/more aliased the further out the user zoomed: the same 1-pixel
// line has to represent a bigger and bigger span of world space. Fat
// lines (LineSegments2/LineMaterial) draw an actual screen-space quad per
// segment instead, so this stays a real, anti-aliased 1px line at any zoom.
const LINE_WIDTH_PX = 1;

// Floor grid on the XZ plane (Y=0) - a fixed scene fixture (not per-
// session/model), purely a visual reference for scale/orientation.
// Visibility is user-toggleable (WorldCanvasComponent.toggleGridVisible),
// which is why the caller keeps its own reference to the returned object
// rather than this file tracking visibility itself.
//
// Unlike voxels.ts's own edge wireframe (see that file's own comment on
// why IT reverted this exact same LineSegments2 approach back to real 3D
// cylinders), this is safe here: the failure mode there was a single
// shared voxel-preview object rendered by SEVERAL different renderers at
// once (six-view, zone painting, the main canvas), each needing a
// DIFFERENT `resolution` uniform value - there's no single correct answer
// to feed the shader. This grid has no such conflict: each of the 3
// WorldCanvasComponent instances builds and owns exactly one, rendered by
// exactly its own one renderer (see updateGridResolution below, called
// from that same component's checkResize).
export function buildFloorGrid(): LineSegments2 {
  const center = GRID_DIVISIONS / 2;
  const step = GRID_SIZE / GRID_DIVISIONS;
  const halfSize = GRID_SIZE / 2;

  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0, k = -halfSize; i <= GRID_DIVISIONS; i++, k += step) {
    positions.push(-halfSize, 0, k, halfSize, 0, k);
    positions.push(k, 0, -halfSize, k, 0, halfSize);
    const color = i === center ? CENTER_LINE_COLOR : GRID_LINE_COLOR;
    for (let corner = 0; corner < 4; corner++) {
      colors.push(color.r, color.g, color.b);
    }
  }

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  geometry.setColors(colors);

  const material = new LineMaterial({ vertexColors: true, linewidth: LINE_WIDTH_PX });
  const grid = new LineSegments2(geometry, material);
  grid.computeLineDistances();
  return grid;
}

// LineMaterial's line-width calculation needs the OWNING renderer's
// current CSS pixel size to convert `linewidth` into the right amount of
// screen-space quad extrusion - there's no way for this module to know
// that on its own (see buildFloorGrid's own comment), so the caller feeds
// it in directly, the same width/height it already passes to
// renderer.setSize on every resize.
export function updateGridResolution(grid: LineSegments2, width: number, height: number): void {
  (grid.material as LineMaterial).resolution.set(width, height);
}
