import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { REAL_WORLD_INDEX, SOLVER_WORLD_INDEX } from '../config/app-settings';
import { ActiveWorldService } from './active-world.service';
import { MeshEditorService } from './mesh-editor.service';
import { SessionsService } from './sessions.service';
import { SolverService } from './solver.service';
import { UndoRedoService } from './undo-redo.service';

describe('UndoRedoService', () => {
  let service: UndoRedoService;
  let mesh: jasmine.SpyObj<MeshEditorService>;
  let solver: jasmine.SpyObj<SolverService>;
  let world: number | null;
  let session: number | null;
  let meshState: { canUndo: boolean; canRedo: boolean } | null;
  let setupUndo: boolean;
  let setupRedo: boolean;

  beforeEach(() => {
    world = REAL_WORLD_INDEX;
    session = 1;
    meshState = { canUndo: true, canRedo: true };
    setupUndo = true;
    setupRedo = true;
    mesh = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['getState', 'undo', 'redo']);
    mesh.getState.and.callFake(() => meshState as never);
    Object.defineProperty(mesh, 'busy', { get: () => signal(false) });
    solver = jasmine.createSpyObj<SolverService>('SolverService', ['canUndoSetup', 'canRedoSetup', 'undoSetup', 'redoSetup']);
    solver.canUndoSetup.and.callFake(() => setupUndo);
    solver.canRedoSetup.and.callFake(() => setupRedo);
    TestBed.configureTestingModule({
      providers: [
        { provide: MeshEditorService, useValue: mesh },
        { provide: SolverService, useValue: solver },
        { provide: SessionsService, useValue: { activeSessionId: () => session } },
        { provide: ActiveWorldService, useValue: { currentWorldIndex: () => world } }
      ]
    });
    service = TestBed.inject(UndoRedoService);
  });

  it('undoes and redoes the mesh in every World but the Solver one', () => {
    expect(service.undo()).toBeTrue();
    expect(service.redo()).toBeTrue();

    expect(mesh.undo).toHaveBeenCalledWith(1);
    expect(mesh.redo).toHaveBeenCalledWith(1);
    expect(solver.undoSetup).not.toHaveBeenCalled();
  });

  it('undoes and redoes the set-up (supports, pressures, materials) in the Solver World', () => {
    world = SOLVER_WORLD_INDEX;

    expect(service.undo()).toBeTrue();
    expect(service.redo()).toBeTrue();

    expect(solver.undoSetup).toHaveBeenCalledWith(1);
    expect(solver.redoSetup).toHaveBeenCalledWith(1);
    expect(mesh.undo).not.toHaveBeenCalled();
  });

  it('does nothing, and says so, when there is nothing to undo or redo, or no session', () => {
    meshState = { canUndo: false, canRedo: false };
    expect(service.undo()).toBeFalse();
    expect(service.redo()).toBeFalse();

    world = SOLVER_WORLD_INDEX;
    setupUndo = false;
    setupRedo = false;
    expect(service.undo()).toBeFalse();

    session = null;
    expect(service.canUndo()).toBeFalse();
    expect(mesh.undo).not.toHaveBeenCalled();
    expect(solver.undoSetup).not.toHaveBeenCalled();
  });
});
