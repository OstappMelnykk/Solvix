import * as THREE from 'three';
import { HexFaceName, MeshFaceDto, MeshPointDto, MeshStateDto } from '../api/mesh-editor-api.service';
import { FACE_NAMES, LOCAL_COORDS } from './mesh-editor-view';

// Layout and cameras of the cube constructor's four views, as plain functions:
// the window shows one cube in a 2x2 grid - front, side, top (orthographic,
// where nodes are dragged in the plane of the view) and a free 3D view.

export type ConstructorRegion = 'front' | 'side' | 'top' | 'perspective';

export const CONSTRUCTOR_REGIONS: readonly ConstructorRegion[] = ['front', 'side', 'top', 'perspective'];

export const REGION_LABELS: Record<ConstructorRegion, string> = {
  front: 'Спереду (X→, Y↑)',
  side: 'Збоку (Z, Y↑)',
  top: 'Зверху (X→, Z)',
  perspective: '3D'
};

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The four equal quadrants of a width x height area, y measured from the TOP:
// front top-left, side top-right, top bottom-left, 3D bottom-right.
export function regionRects(width: number, height: number): Record<ConstructorRegion, Rect> {
  const w = width / 2;
  const h = height / 2;
  return {
    front: { x: 0, y: 0, width: w, height: h },
    side: { x: w, y: 0, width: w, height: h },
    top: { x: 0, y: h, width: w, height: h },
    perspective: { x: w, y: h, width: w, height: h }
  };
}

export function regionAt(width: number, height: number, x: number, y: number): ConstructorRegion | null {
  if (x < 0 || y < 0 || x > width || y > height) {
    return null;
  }
  const rects = regionRects(width, height);
  return CONSTRUCTOR_REGIONS.find(r => x >= rects[r].x && x <= rects[r].x + rects[r].width && y >= rects[r].y && y <= rects[r].y + rects[r].height) ?? null;
}

// Normalised device coordinates of a pointer inside one region.
export function regionNdc(rect: Rect, x: number, y: number): THREE.Vector2 {
  return new THREE.Vector2(((x - rect.x) / rect.width) * 2 - 1, -(((y - rect.y) / rect.height) * 2 - 1));
}

export function positionsBounds(positions: readonly MeshPointDto[]): THREE.Box3 {
  const box = new THREE.Box3();
  positions.forEach(p => box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z)));
  return box;
}

const VIEW_DIRECTIONS: Record<'front' | 'side' | 'top', { eye: THREE.Vector3; up: THREE.Vector3 }> = {
  front: { eye: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
  side: { eye: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  top: { eye: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) }
};

// An orthographic camera looking at the cube from one side, framed so the whole
// cube (plus a margin) fits whatever the region's aspect ratio is.
export function orthoCameraFor(region: 'front' | 'side' | 'top', bounds: THREE.Box3, aspect: number): THREE.OrthographicCamera {
  const centre = bounds.isEmpty() ? new THREE.Vector3(0.5, 0.5, 0.5) : bounds.getCenter(new THREE.Vector3());
  const size = bounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 0.2);
  const half = extent * 0.75;
  const camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.01, extent * 20 + 100);
  const { eye, up } = VIEW_DIRECTIONS[region];
  camera.position.copy(centre).addScaledVector(eye, extent * 5 + 10);
  camera.up.copy(up);
  camera.lookAt(centre);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

export function perspectiveCameraFor(bounds: THREE.Box3, aspect: number): THREE.PerspectiveCamera {
  const centre = bounds.isEmpty() ? new THREE.Vector3(0.5, 0.5, 0.5) : bounds.getCenter(new THREE.Vector3());
  const size = bounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 0.2);
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.01, extent * 50 + 100);
  camera.position.copy(centre).add(new THREE.Vector3(1.4, 1.1, 1.7).multiplyScalar(extent * 1.6));
  camera.lookAt(centre);
  camera.updateMatrixWorld();
  return camera;
}

// The drawn cube is the editor's own view of ONE hex whose 20 nodes have ids 0..19
// (= local slots), so the constructor reuses the same drawing code as the scene.
export function shapeToState(positions: readonly MeshPointDto[]): MeshStateDto {
  const faces: MeshFaceDto[] = FACE_NAMES.map((face: HexFaceName) => ({
    hex: 0,
    face,
    status: 'Free',
    otherHex: null,
    otherFace: null,
    coincident: null,
    gap: null
  }));
  return {
    version: 0,
    canUndo: false,
    canRedo: false,
    nodes: positions.map((p, slot) => ({
      id: slot,
      x: p.x,
      y: p.y,
      z: p.z,
      idealX: LOCAL_COORDS[slot][0] + 1,
      idealY: LOCAL_COORDS[slot][1] + 1,
      idealZ: LOCAL_COORDS[slot][2] + 1
    })),
    hexes: [{ id: 0, cellI: 0, cellJ: 0, cellK: 0, nodeIds: positions.map((_, slot) => slot) }],
    links: [],
    faces,
    invalidHexes: []
  };
}
