import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { SharedModelService } from './shared-model.service';
import { SessionsService } from './sessions.service';

describe('SharedModelService', () => {
  let sessions: SessionsService;
  let models: SharedModelService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    sessions = TestBed.inject(SessionsService);
    models = TestBed.inject(SharedModelService);
  });

  it('gives the same session the same model instance on repeated calls', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(models.getModel(sessionId)).toBe(models.getModel(sessionId));
  });

  it('disposes a closed session\'s model geometry/material (GPU resources)', () => {
    const sessionId = sessions.sessions()[0].id;
    const model = models.getModel(sessionId) as THREE.Mesh;
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

    const firstModel = models.getModel(first) as THREE.Mesh;
    const secondModel = models.getModel(second) as THREE.Mesh;
    const firstDispose = spyOn(firstModel.geometry, 'dispose');
    const secondDispose = spyOn(secondModel.geometry, 'dispose');

    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(firstDispose).toHaveBeenCalled();
    expect(secondDispose).not.toHaveBeenCalled();
  });
});