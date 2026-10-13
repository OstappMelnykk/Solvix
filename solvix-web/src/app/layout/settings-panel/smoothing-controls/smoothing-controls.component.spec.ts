import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { singleCubeState } from '../../../geometry/mesh-state.fixture.spec';
import { SmoothingControlsComponent } from './smoothing-controls.component';

describe('SmoothingControlsComponent', () => {
  let editor: jasmine.SpyObj<MeshEditorService>;
  let busy: ReturnType<typeof signal<boolean>>;
  let cubes: number;
  let component: SmoothingControlsComponent;

  beforeEach(() => {
    busy = signal(false);
    cubes = 27;
    editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['getState', 'smooth', 'undo']);
    editor.getState.and.callFake(() => ({ hexes: new Array(cubes).fill({}) }) as never);
    Object.defineProperty(editor, 'busy', { get: () => busy });
    TestBed.configureTestingModule({ providers: [{ provide: MeshEditorService, useValue: editor }] });
    component = TestBed.runInInjectionContext(() => new SmoothingControlsComponent());
    component.sessionId = 1;
  });

  const type = (field: 'iterations' | 'relaxation' | 'density' | 'angle' | 'shape', value: string) =>
    component.onNumber(field, { target: { value } } as unknown as Event);

  it('smooths with the settings the user chose, each kept within its range', () => {
    component.smooth();
    expect(editor.smooth).toHaveBeenCalledWith(1, { iterations: 100, relaxation: 0.5, surface: false, density: 1, featureAngle: 25, untangle: true, straighten: true, shapeTolerance: 0 }, jasmine.any(Function));

    type('iterations', '25.4');
    type('relaxation', '0.2');
    type('density', '40');
    type('angle', '60');
    type('shape', '20');
    component.onSurface({ target: { checked: true } } as unknown as Event);
    component.onUntangle({ target: { checked: false } } as unknown as Event);
    component.onStraighten({ target: { checked: false } } as unknown as Event);
    component.smooth();
    expect(editor.smooth).toHaveBeenCalledWith(1, { iterations: 25, relaxation: 0.2, surface: true, density: 0.4, featureAngle: 60, untangle: false, straighten: false, shapeTolerance: 0.2 }, jasmine.any(Function));

    type('iterations', '9999');
    type('relaxation', '0');
    type('density', '500');
    type('angle', '0');
    type('shape', '999');
    expect([component.iterations, component.relaxation, component.densityPercent, component.featureAngle, component.shapeTolerancePercent]).toEqual([500, 0.05, 100, 1, 50]);
  });

  it('says how much of the mesh smoothing can reach: here nothing, a single cube has no free vertex', () => {
    editor.getState.and.returnValue(singleCubeState());
    component.bad = [{ hex: 0 }];

    const reach = component.reach()!;

    expect(reach.free).toBe(0);
    expect(reach.badReachable).toBe(0);
    expect(component.reach()).toBe(reach);                       // the same object while nothing changed
  });

  it('can take the smoothing back, but only while the mesh is as the smoothing left it', () => {
    let version = 4;
    let canUndo = true;
    editor.getState.and.callFake(() => ({ hexes: new Array(cubes).fill({}), version, canUndo }) as never);
    expect(component.canRevert()).toBeFalse();                    // nothing smoothed yet

    component.smooth();
    version = 5;
    editor.smooth.calls.mostRecent().args[2]!();                  // the server answered: the mesh is at version 5
    expect(component.canRevert()).toBeTrue();

    component.revert();
    expect(editor.undo).toHaveBeenCalledWith(1);

    version = 6;                                                  // anything done after it (the undo too) ends the offer
    expect(component.canRevert()).toBeFalse();
    version = 5;
    canUndo = false;
    expect(component.canRevert()).toBeFalse();
  });

  it('does nothing while busy or with a single cube', () => {
    busy.set(true);
    component.smooth();
    busy.set(false);
    cubes = 1;
    component.smooth();

    expect(editor.smooth).not.toHaveBeenCalled();
  });
});
