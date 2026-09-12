import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { ImportedReferenceRenderService } from './imported-reference-render.service';
import { ImportedGeometryService } from './imported-geometry.service';
import { ImportedReferenceDisplayService } from './imported-reference-display.service';
import { SessionsService } from './sessions.service';

function box(width: number, height: number, depth: number): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial()));
  return group;
}

function worldBox(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

describe('ImportedReferenceRenderService', () => {
  let sessions: SessionsService;
  let importedGeometry: ImportedGeometryService;
  let display: ImportedReferenceDisplayService;
  let render: ImportedReferenceRenderService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    sessions = TestBed.inject(SessionsService);
    importedGeometry = TestBed.inject(ImportedGeometryService);
    display = TestBed.inject(ImportedReferenceDisplayService);
    render = TestBed.inject(ImportedReferenceRenderService);
  });

  it('defaults density to 10 and reports no scale/reference before anything is imported', () => {
    const sessionId = sessions.sessions()[0].id;

    expect(render.getDensity(sessionId)).toBe(10);
    expect(render.getScale(sessionId)).toBeNull();
    expect(render.getScaledReference(sessionId)).toBeNull();
  });

  it('setDensity clamps to [1, 90] and rounds', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(2, 1, 1), 'model.glb');

    render.setDensity(sessionId, 500);
    expect(render.getDensity(sessionId)).toBe(90);

    render.setDensity(sessionId, -5);
    expect(render.getDensity(sessionId)).toBe(1);

    render.setDensity(sessionId, 12.6);
    expect(render.getDensity(sessionId)).toBe(13);
  });

  it('computes scale as density / longest bounding-box length', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(2, 1, 1), 'model.glb'); // longest = 2
    render.setDensity(sessionId, 10);

    expect(render.getScale(sessionId)).toBeCloseTo(5, 5); // 10 / 2
  });

  it('refreshScaledReference builds a clone scaled and grounded at the target density', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(2, 1, 1), 'model.glb'); // longest = 2
    render.setDensity(sessionId, 10); // scale = 5 -> displayed longest = 10

    const clone = render.getScaledReference(sessionId)!;
    const result = worldBox(clone);
    const size = result.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(10, 4);
    expect(result.min.y).toBeCloseTo(0, 4);
    expect(result.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 4);
  });

  it('rebuilding density does not mutate the raw ImportedGeometryService object', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(2, 1, 1), 'model.glb');
    const rawBefore = worldBox(importedGeometry.get(sessionId)!.object).clone();

    render.setDensity(sessionId, 50);

    const rawAfter = worldBox(importedGeometry.get(sessionId)!.object);
    expect(rawAfter.min.equals(rawBefore.min)).toBe(true);
    expect(rawAfter.max.equals(rawBefore.max)).toBe(true);
  });

  it('builds dimension lines and a ruler alongside the scaled clone, sharing its transform', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(2, 1, 1), 'model.glb');
    render.setDensity(sessionId, 10);

    const clone = render.getScaledReference(sessionId)!;
    const lines = render.getDimensionLines(sessionId)!;
    const ruler = render.getRuler(sessionId)!;

    expect(lines).not.toBeNull();
    expect(ruler).not.toBeNull();
    expect(lines.position.equals(clone.position)).toBe(true);
    expect(lines.quaternion.equals(clone.quaternion)).toBe(true);
    expect(ruler.position.equals(clone.position)).toBe(true);
  });

  it('setRotation rotates around the object\'s own center and stays grounded at Y=0', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(2, 1, 3), 'model.glb');
    render.setDensity(sessionId, 20); // longest(3) scaled to 20

    const quarterTurnAroundZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    render.setRotation(sessionId, quarterTurnAroundZ);

    const clone = render.getScaledReference(sessionId)!;
    expect(clone.quaternion.equals(quarterTurnAroundZ)).toBe(true);
    const result = worldBox(clone);
    expect(result.min.y).toBeCloseTo(0, 4);
    expect(result.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 4);
  });

  it('getRotation defaults to identity and resetRotation reverts a later rebuild to identity', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(2, 1, 1), 'model.glb');
    render.setDensity(sessionId, 10);
    expect(render.getRotation(sessionId).equals(new THREE.Quaternion())).toBe(true);

    render.setRotation(sessionId, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4));
    expect(render.getRotation(sessionId).equals(new THREE.Quaternion())).toBe(false);

    render.resetRotation(sessionId);
    render.refreshScaledReference(sessionId);

    expect(render.getRotation(sessionId).equals(new THREE.Quaternion())).toBe(true);
    expect(render.getScaledReference(sessionId)!.quaternion.equals(new THREE.Quaternion())).toBe(true);
  });

  it('refreshRuler alone picks up a new rulerDistance without rebuilding the scaled reference identity', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(2, 1, 1), 'model.glb');
    render.setDensity(sessionId, 10);
    const referenceBefore = render.getScaledReference(sessionId);

    display.setRulerDistance(sessionId, 5);
    render.refreshRuler(sessionId);

    expect(render.getScaledReference(sessionId)).toBe(referenceBefore!); // unchanged identity
    expect(render.getRuler(sessionId)).not.toBeNull();
  });

  it('clears the cached reference/lines/ruler when there is nothing imported', () => {
    const sessionId = sessions.sessions()[0].id;

    render.refreshScaledReference(sessionId);

    expect(render.getScaledReference(sessionId)).toBeNull();
    expect(render.getDimensionLines(sessionId)).toBeNull();
    expect(render.getRuler(sessionId)).toBeNull();
  });

  // Regression: the early-return path (nothing imported, or a degenerate
  // zero-extent import whose scale is undefined) used to skip emitting
  // referenceChanged$ entirely - a consumer that cached something computed
  // from a PREVIOUS, valid reference (VoxelizationService's voxel preview)
  // never found out that reference was gone, and kept showing a stale
  // result forever with no way to clear it.
  it('emits referenceChanged$ even when refreshScaledReference has nothing to build', () => {
    const sessionId = sessions.sessions()[0].id;
    const emitted: number[] = [];
    render.referenceChanged$.subscribe(id => emitted.push(id));

    render.refreshScaledReference(sessionId); // nothing imported at all
    expect(emitted).toEqual([sessionId]);

    importedGeometry.set(sessionId, box(0, 0, 0), 'degenerate.glb'); // longestLength <= 0 -> scale null
    render.refreshScaledReference(sessionId);
    expect(emitted).toEqual([sessionId, sessionId]);
  });

  it('disposes dimension lines and ruler (but not the shared reference geometry) when a session closes', () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;
    importedGeometry.set(first, box(2, 1, 1), 'first.glb');
    importedGeometry.set(second, box(2, 1, 1), 'second.glb');
    render.setDensity(first, 10);
    render.setDensity(second, 10);
    const firstLineSegments = render.getDimensionLines(first)!.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments;
    const secondLineSegments = render.getDimensionLines(second)!.children.find(c => c instanceof THREE.LineSegments) as THREE.LineSegments;
    const firstLinesDispose = spyOn(firstLineSegments.geometry, 'dispose');
    const secondLinesDispose = spyOn(secondLineSegments.geometry, 'dispose');

    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(firstLinesDispose).toHaveBeenCalled();
    expect(secondLinesDispose).not.toHaveBeenCalled();
    expect(render.getScaledReference(first)).toBeNull();
    expect(render.getScaledReference(second)).not.toBeNull();
  });
});