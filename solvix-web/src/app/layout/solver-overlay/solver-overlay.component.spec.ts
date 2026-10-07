import { TestBed } from '@angular/core/testing';
import { SolverOverlayComponent } from './solver-overlay.component';
import { PickMode, SolverService } from '../../state/solver.service';
import { SolverResultDto } from '../../api/solver-api.service';

describe('SolverOverlayComponent', () => {
  let solver: jasmine.SpyObj<SolverService>;
  let component: SolverOverlayComponent;
  let mode: PickMode;
  let result: SolverResultDto | null;
  let display: { field: 'none' | 'vonMises' | 'displacement'; deformationScale: number; opacity: number };
  let auto: boolean;

  beforeEach(() => {
    mode = 'load';
    auto = false;
    display = { field: 'vonMises', deformationScale: 1000, opacity: 1 };
    result = null;
    solver = jasmine.createSpyObj<SolverService>('SolverService', [
      'mode', 'setMode', 'loadedFaceCount', 'fixedFaceCount', 'isFixedAuto', 'result', 'display', 'setDeformationScale', 'setOpacity'
    ]);
    solver.mode.and.callFake(() => mode);
    solver.loadedFaceCount.and.returnValue(12);
    solver.fixedFaceCount.and.returnValue(8);
    solver.isFixedAuto.and.callFake(() => auto);
    solver.result.and.callFake(() => result);
    solver.display.and.callFake(() => display);
    TestBed.configureTestingModule({ providers: [{ provide: SolverService, useValue: solver }] });
    component = TestBed.runInInjectionContext(() => new SolverOverlayComponent());
    component.sessionId = 1;
  });

  it('switches what a click on a face does, between Load and Fix', () => {
    expect(component.mode()).toBe('load');

    component.setMode('fix');

    expect(solver.setMode).toHaveBeenCalledWith(1, 'fix');
  });

  it('legend of the marked faces: how many small faces are pressed and clamped, and "(авто)" for the automatic clamping', () => {
    expect(component.loadedText()).toBe('12 граней СЕ');
    expect(component.fixedText()).toBe('8 граней СЕ');
    auto = true;
    expect(component.fixedText()).toBe('8 граней СЕ (авто)');
  });

  describe('see-through', () => {
    it('shows the opacity in percent and sets it from the slider', () => {
      display.opacity = 0.37;
      expect(component.opacityPercent()).toBe(37);

      component.onOpacity({ target: { value: '60' } } as unknown as Event);
      component.onOpacity({ target: { value: 'x' } } as unknown as Event);

      expect(solver.setOpacity.calls.allArgs()).toEqual([[1, 0.6]]);
    });
  });

  describe('deformation', () => {
    beforeEach(() => {
      result = { ticket: 1, divisions: [1, 1, 1], positions: [0, 0, 0], hexIds: [], gridNodes: [], ux: [0], uy: [0], uz: [0], vonMises: [4e6], maxDisplacement: 2e-5, maxVonMises: 4e6, elapsedSeconds: 0 };
    });

    it('is there only with a result', () => {
      expect(component.hasResult()).toBeTrue();
      result = null;
      expect(component.hasResult()).toBeFalse();
    });

    it('the number box sets the factor up to the solver\'s 500000, ignoring junk', () => {
      component.onScaleNumber({ target: { value: '2500' } } as unknown as Event);
      component.onScaleNumber({ target: { value: '9999999' } } as unknown as Event);
      component.onScaleNumber({ target: { value: 'x' } } as unknown as Event);

      expect(solver.setDeformationScale.calls.allArgs()).toEqual([[1, 2500], [1, 500000]]);
    });

    it('the slider is cubic, so the small factors stay reachable, and round-trips with the factor', () => {
      component.onScaleSlider({ target: { value: '100' } } as unknown as Event);
      component.onScaleSlider({ target: { value: '50' } } as unknown as Event);
      component.onScaleSlider({ target: { value: '0' } } as unknown as Event);
      expect(solver.setDeformationScale.calls.allArgs()).toEqual([[1, 500000], [1, 62500], [1, 0]]);

      display.deformationScale = 62500;
      expect(component.scaleSlider()).toBe(50);
      display.deformationScale = 999999;
      expect(component.scaleSlider()).toBe(100);
    });

    it('says what is shown against what is real', () => {
      display.deformationScale = 1000;

      expect(component.shownText()).toBe('Показано: 2.00e-2 (реально: 2.00e-5)');
      result = null;
      expect(component.shownText()).toBe('');
    });
  });

  describe('the colour scale', () => {
    beforeEach(() => {
      result = { ticket: 1, divisions: [1, 1, 1], positions: [0, 0, 0, 1, 0, 0], hexIds: [], gridNodes: [], ux: [0, 3e-5], uy: [0, 4e-5], uz: [0, 0], vonMises: [1e6, 8e6], maxDisplacement: 5e-5, maxVonMises: 8e6, elapsedSeconds: 0 };
    });

    it('is a bar from red (top) to blue with the maximum of the shown field', () => {
      const legend = component.legend()!;

      expect(legend.max).toBe('8.000 МПа');
      expect(legend.min).toBe('0.000 МПа'.replace('0.000 МПа', '0.000 МПа'));
      expect(legend.label).toBe('Von Mises');
      expect(legend.gradient).toContain('linear-gradient(to bottom');
      expect(legend.gradient).toContain('#e4572e');
    });

    it('follows the field: displacement has its own maximum, "materials" and no result have no bar', () => {
      display.field = 'displacement';
      expect(component.legend()!.max).toBe('5.00e-5');
      expect(component.legend()!.label).toBe('Переміщення');

      display.field = 'none';
      expect(component.legend()).toBeNull();
      display.field = 'vonMises';
      result = null;
      expect(component.legend()).toBeNull();
    });
  });
});
