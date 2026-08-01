import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { WorldCameraMemoryService } from './world-camera-memory.service';
import { SessionsService } from './sessions.service';

describe('WorldCameraMemoryService', () => {
  let sessions: SessionsService;
  let cameraMemory: WorldCameraMemoryService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    sessions = TestBed.inject(SessionsService);
    cameraMemory = TestBed.inject(WorldCameraMemoryService);
  });

  it('has nothing saved for a fresh (session, world) pair', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(cameraMemory.get(sessionId, 0)).toBeUndefined();
  });

  it('remembers a saved state per (session, world)', () => {
    const sessionId = sessions.sessions()[0].id;
    const state = { position: new THREE.Vector3(1, 2, 3), target: new THREE.Vector3() };

    cameraMemory.set(sessionId, 1, state);

    expect(cameraMemory.get(sessionId, 1)).toBe(state);
    expect(cameraMemory.get(sessionId, 0)).toBeUndefined();
  });

  it('clears a closed session\'s saved states across all worlds', () => {
    const sessionId = sessions.sessions()[0].id;
    cameraMemory.set(sessionId, 0, { position: new THREE.Vector3(), target: new THREE.Vector3() });
    cameraMemory.set(sessionId, 2, { position: new THREE.Vector3(), target: new THREE.Vector3() });

    sessions.closeSession(sessionId);
    TestBed.flushEffects();

    expect(cameraMemory.get(sessionId, 0)).toBeUndefined();
    expect(cameraMemory.get(sessionId, 2)).toBeUndefined();
  });

  it('does not clear a session that stays open', () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;
    const state = { position: new THREE.Vector3(), target: new THREE.Vector3() };

    cameraMemory.set(second, 0, state);
    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(cameraMemory.get(second, 0)).toBe(state);
  });
});