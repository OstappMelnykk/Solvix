import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { ImportedGeometryService } from './imported-geometry.service';
import { SessionsService } from './sessions.service';

function closedBox(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  return group;
}

// A box authored off to one side, the way a real file's local origin
// commonly isn't at its own geometric center.
function offsetBox(): THREE.Object3D {
  const group = closedBox();
  group.position.set(10, 20, -5);
  return group;
}

// ImportedGeometryService.set() wraps the loaded object in its own pivot
// Group, so the stored entry's Mesh is nested one level deeper than the
// raw object passed in - traverse rather than assume a fixed child index.
function findMesh(object: THREE.Object3D): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      found = child;
    }
  });
  if (!found) {
    throw new Error('no mesh found');
  }
  return found;
}

describe('ImportedGeometryService', () => {
  let sessions: SessionsService;
  let imported: ImportedGeometryService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    sessions = TestBed.inject(SessionsService);
    imported = TestBed.inject(ImportedGeometryService);
  });

  it('has nothing imported for a session by default', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(imported.get(sessionId)).toBeNull();
  });

  it('stores the object and computes watertight for a closed mesh', () => {
    const sessionId = sessions.sessions()[0].id;
    imported.set(sessionId, closedBox(), 'model.glb');

    const entry = imported.get(sessionId);
    expect(entry?.fileName).toBe('model.glb');
    expect(entry?.watertight).toBe(true);
  });

  it('recenters an off-center import so its footprint is centered and it rests on Y=0', () => {
    const sessionId = sessions.sessions()[0].id;
    imported.set(sessionId, offsetBox(), 'offset.glb');

    const entry = imported.get(sessionId)!;
    const center = entry.boundingBox.getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.z).toBeCloseTo(0, 5);
    expect(entry.boundingBox.min.y).toBeCloseTo(0, 5);
  });

  it('disposes the previous import when a new file replaces it', () => {
    const sessionId = sessions.sessions()[0].id;
    imported.set(sessionId, closedBox(), 'first.glb');
    const firstMesh = findMesh(imported.get(sessionId)!.object);
    const geometryDispose = spyOn(firstMesh.geometry, 'dispose');

    imported.set(sessionId, closedBox(), 'second.glb');

    expect(geometryDispose).toHaveBeenCalled();
    expect(imported.get(sessionId)?.fileName).toBe('second.glb');
  });

  it('disposes a closed session\'s import and leaves other sessions untouched', () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;

    imported.set(first, closedBox(), 'first.glb');
    imported.set(second, closedBox(), 'second.glb');
    const firstMesh = findMesh(imported.get(first)!.object);
    const secondMesh = findMesh(imported.get(second)!.object);
    const firstDispose = spyOn(firstMesh.geometry, 'dispose');
    const secondDispose = spyOn(secondMesh.geometry, 'dispose');

    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(firstDispose).toHaveBeenCalled();
    expect(secondDispose).not.toHaveBeenCalled();
  });
});