import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { INITIAL_MODEL_FACTORY, SharedModelService } from './shared-model.service';
import { SessionsService } from './sessions.service';

// A stand-in initial model with an actual Mesh child, for tests that need
// something with GPU resources to dispose - the real default (an empty
// THREE.Group, see shared-model.service.ts) has nothing to dispose at all.
function meshModel(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  return group;
}

describe('SharedModelService', () => {
  let sessions: SessionsService;
  let models: SharedModelService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: INITIAL_MODEL_FACTORY, useValue: meshModel }]
    });
    sessions = TestBed.inject(SessionsService);
    models = TestBed.inject(SharedModelService);
  });

  it('gives the same session the same model instance on repeated calls', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(models.getModel(sessionId)).toBe(models.getModel(sessionId));
  });

  it('starts a brand-new session with an empty model by default', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const defaultSessions = TestBed.inject(SessionsService);
    const defaultModels = TestBed.inject(SharedModelService);

    const model = defaultModels.getModel(defaultSessions.sessions()[0].id);
    expect(model).toBeInstanceOf(THREE.Group);
    expect(model.children.length).toBe(0);
  });

  it('disposes a closed session\'s model geometry/material (GPU resources)', () => {
    const sessionId = sessions.sessions()[0].id;
    const model = models.getModel(sessionId).children[0] as THREE.Mesh;
    const geometryDispose = spyOn(model.geometry, 'dispose');
    const materialDispose = spyOn(model.material as THREE.Material, 'dispose');

    sessions.closeSession(sessionId);
    TestBed.flushEffects();

    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
  });

  it('does not touch a model belonging to a session that stays open', () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;

    const firstModel = models.getModel(first).children[0] as THREE.Mesh;
    const secondModel = models.getModel(second).children[0] as THREE.Mesh;
    const firstDispose = spyOn(firstModel.geometry, 'dispose');
    const secondDispose = spyOn(secondModel.geometry, 'dispose');

    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(firstDispose).toHaveBeenCalled();
    expect(secondDispose).not.toHaveBeenCalled();
  });
});