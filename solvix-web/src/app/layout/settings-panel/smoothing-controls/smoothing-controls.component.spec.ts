import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { SmoothingControlsComponent } from './smoothing-controls.component';

describe('SmoothingControlsComponent', () => {
  let editor: jasmine.SpyObj<MeshEditorService>;
  let busy: ReturnType<typeof signal<boolean>>;
  let cubes: number;
  let component: SmoothingControlsComponent;

  beforeEach(() => {
    busy = signal(false);
    cubes = 27;
    editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['getState', 'smooth']);
    editor.getState.and.callFake(() => ({ hexes: new Array(cubes).fill({}) }) as never);
    Object.defineProperty(editor, 'busy', { get: () => busy });
    TestBed.configureTestingModule({ providers: [{ provide: MeshEditorService, useValue: editor }] });
    component = TestBed.runInInjectionContext(() => new SmoothingControlsComponent());
    component.sessionId = 1;
  });

  const type = (field: 'iterations' | 'relaxation' | 'density' | 'angle', value: string) =>
    component.onNumber(field, { target: { value } } as unknown as Event);

  it('smooths with the settings the user chose, each kept within its range', () => {
    component.smooth();
    expect(editor.smooth).toHaveBeenCalledWith(1, { iterations: 10, relaxation: 0.5, surface: false, density: 1, featureAngle: 25 });

    type('iterations', '25.4');
    type('relaxation', '0.2');
    type('density', '40');
    type('angle', '60');
    component.onSurface({ target: { checked: true } } as unknown as Event);
    component.smooth();
    expect(editor.smooth).toHaveBeenCalledWith(1, { iterations: 25, relaxation: 0.2, surface: true, density: 0.4, featureAngle: 60 });

    type('iterations', '9999');
    type('relaxation', '0');
    type('density', '500');
    type('angle', '0');
    expect([component.iterations, component.relaxation, component.densityPercent, component.featureAngle]).toEqual([200, 0.05, 100, 1]);
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
