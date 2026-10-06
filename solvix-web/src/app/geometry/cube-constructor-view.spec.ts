import * as THREE from 'three';
import {
  CONSTRUCTOR_REGIONS,
  orthoCameraFor,
  perspectiveCameraFor,
  positionsBounds,
  regionAt,
  regionNdc,
  regionRects,
  shapeToState
} from './cube-constructor-view';
import { buildMeshView } from './mesh-editor-view';
import { unitPositions } from '../state/cube-constructor.service';

describe('cube-constructor-view', () => {
  describe('regions', () => {
    it('are four equal quadrants covering the area', () => {
      const rects = regionRects(800, 600);

      expect(rects.front).toEqual({ x: 0, y: 0, width: 400, height: 300 });
      expect(rects.side).toEqual({ x: 400, y: 0, width: 400, height: 300 });
      expect(rects.top).toEqual({ x: 0, y: 300, width: 400, height: 300 });
      expect(rects.perspective).toEqual({ x: 400, y: 300, width: 400, height: 300 });
    });

    it('tell which quadrant a point is in, and null outside', () => {
      expect(regionAt(800, 600, 100, 100)).toBe('front');
      expect(regionAt(800, 600, 700, 100)).toBe('side');
      expect(regionAt(800, 600, 100, 500)).toBe('top');
      expect(regionAt(800, 600, 700, 500)).toBe('perspective');
      expect(regionAt(800, 600, -1, 10)).toBeNull();
      expect(regionAt(800, 600, 10, 601)).toBeNull();
      expect(CONSTRUCTOR_REGIONS.length).toBe(4);
    });

    it('turn a pointer into normalised device coordinates inside its own region', () => {
      const rect = { x: 400, y: 300, width: 400, height: 300 };

      expect(regionNdc(rect, 600, 450).toArray()).toEqual([0, -0]);       // the centre
      expect(regionNdc(rect, 400, 300).toArray()).toEqual([-1, 1]);       // top-left corner
      expect(regionNdc(rect, 800, 600).toArray()).toEqual([1, -1]);       // bottom-right corner
    });
  });

  describe('cameras', () => {
    const unitBounds = () => positionsBounds(unitPositions());

    it('the front view looks along -Z with Y up: a point to the right and above appears right and above', () => {
      const camera = orthoCameraFor('front', unitBounds(), 1);

      const right = new THREE.Vector3(1, 0.5, 0.5).project(camera);
      const left = new THREE.Vector3(0, 0.5, 0.5).project(camera);
      const high = new THREE.Vector3(0.5, 1, 0.5).project(camera);
      const low = new THREE.Vector3(0.5, 0, 0.5).project(camera);
      expect(right.x).toBeGreaterThan(left.x);
      expect(high.y).toBeGreaterThan(low.y);
    });

    it('the side view looks along -X: +Z is on the left, Y up', () => {
      const camera = orthoCameraFor('side', unitBounds(), 1);

      const deep = new THREE.Vector3(0.5, 0.5, 1).project(camera);
      const shallow = new THREE.Vector3(0.5, 0.5, 0).project(camera);
      expect(deep.x).toBeLessThan(shallow.x);
      expect(new THREE.Vector3(0.5, 1, 0.5).project(camera).y).toBeGreaterThan(new THREE.Vector3(0.5, 0, 0.5).project(camera).y);
    });

    it('the top view looks down along -Y: +X to the right, +Z towards the viewer (down the screen)', () => {
      const camera = orthoCameraFor('top', unitBounds(), 1);

      expect(new THREE.Vector3(1, 0.5, 0.5).project(camera).x).toBeGreaterThan(new THREE.Vector3(0, 0.5, 0.5).project(camera).x);
      expect(new THREE.Vector3(0.5, 0.5, 1).project(camera).y).toBeLessThan(new THREE.Vector3(0.5, 0.5, 0).project(camera).y);
    });

    it('every orthographic view fits the whole cube, also a long beam, whatever the aspect', () => {
      const beam = positionsBounds(unitPositions().map(p => ({ x: p.x * 4, y: p.y, z: p.z })));

      for (const region of ['front', 'side', 'top'] as const) {
        for (const aspect of [0.6, 1, 2]) {
          const camera = orthoCameraFor(region, beam, aspect);
          for (const corner of [new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 1, 1), new THREE.Vector3(4, 0, 1), new THREE.Vector3(0, 1, 0)]) {
            const ndc = corner.clone().project(camera);
            expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1.0001);
            if (aspect >= 1) {
              expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1.0001);
            }
          }
        }
      }
    });

    it('is centred on the cube', () => {
      const camera = orthoCameraFor('front', unitBounds(), 1);

      const centre = new THREE.Vector3(0.5, 0.5, 0.5).project(camera);
      expect(centre.x).toBeCloseTo(0, 6);
      expect(centre.y).toBeCloseTo(0, 6);
    });

    it('an empty bounds still gives a sensible camera, and the 3D camera sees the centre', () => {
      const camera = orthoCameraFor('front', new THREE.Box3(), 1.5);
      expect(Number.isFinite(camera.left) && Number.isFinite(camera.top)).toBeTrue();

      const perspective = perspectiveCameraFor(unitBounds(), 1.5);
      const centre = new THREE.Vector3(0.5, 0.5, 0.5).project(perspective);
      expect(Math.abs(centre.x)).toBeLessThan(1e-6);
      expect(Math.abs(centre.y)).toBeLessThan(1e-6);
      expect(perspective.aspect).toBe(1.5);
    });
  });

  describe('shapeToState', () => {
    it('describes one hex whose node ids are the local slots', () => {
      const state = shapeToState(unitPositions());

      expect(state.hexes.length).toBe(1);
      expect(state.hexes[0].nodeIds).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(state.nodes.length).toBe(20);
      expect(state.nodes[6]).toEqual(jasmine.objectContaining({ id: 6, x: 1, y: 1, z: 1, idealX: 2, idealY: 2, idealZ: 2 }));
      expect(state.faces.length).toBe(6);
      expect(state.faces.every(f => f.status === 'Free')).toBeTrue();
    });

    it('draws with the editor\'s own view code: 6 faces and 20 nodes to pick, the picked slot highlighted', () => {
      const view = buildMeshView(shapeToState(unitPositions()), 'real', { hexes: [], face: null, hoverFace: null, nodeId: 3 });

      expect(view.nodeMeshes.size).toBe(20);
      expect(view.pickables.length).toBe(26);
      const picked = (view.nodeMeshes.get(3)!.material as THREE.MeshBasicMaterial).color.getHex();
      expect(picked).not.toBe((view.nodeMeshes.get(4)!.material as THREE.MeshBasicMaterial).color.getHex());
    });

    it('moves a node with its position', () => {
      const moved = unitPositions().map((p, i) => (i === 6 ? { x: 2, y: 3, z: 4 } : p));

      const view = buildMeshView(shapeToState(moved), 'real', { hexes: [], face: null, hoverFace: null, nodeId: null });

      expect(view.nodeMeshes.get(6)!.position.toArray()).toEqual([2, 3, 4]);
    });
  });
});
