import { TestBed } from '@angular/core/testing';
import { SolverOverlayComponent, TOOLS } from './solver-overlay.component';
import { SolverService } from '../../state/solver.service';
import { Scope, Tool } from '../../geometry/solver-targets';
import { SolverMaterialDto, SolverResultDto, SolverSetupDto } from '../../api/solver-api.service';

describe('SolverOverlayComponent', () => {
  let solver: jasmine.SpyObj<SolverService>;
  let component: SolverOverlayComponent;
  let tool: Tool;
  let scope: Scope;
  let divisions: number[];
  let result: SolverResultDto | null;
  let display: { field: 'none' | 'vonMises' | 'displacement'; deformationScale: number; opacity: number; colorMax: number | null; edges: boolean; vectors: boolean };
  let auto: boolean;
  const materials: SolverMaterialDto[] = [
    { name: 'steel', label: 'Сталь', e: 2.1e11, nu: 0.3 },
    { name: 'rubber', label: 'Гума', e: 1e7, nu: 0.45 }
  ];

  beforeEach(() => {
    tool = 'view';
    scope = 'cell';
    divisions = [2, 1, 1];
    auto = false;
    display = { field: 'vonMises', deformationScale: 1000, opacity: 1, colorMax: null, edges: true, vectors: true };
    result = null;
    solver = jasmine.createSpyObj<SolverService>('SolverService', [
      'tool', 'setTool', 'scopesOf', 'scope', 'setScope', 'depth', 'setDepth', 'divisions', 'setup', 'activeMaterial', 'setActiveMaterial',
      'loadedFaceCount', 'fixedFaceCount', 'isFixedAuto', 'result', 'display', 'setDeformationScale', 'setOpacity', 'showInner', 'setShowInner'
    ]);
    solver.tool.and.callFake(() => tool);
    solver.scope.and.callFake(() => scope);
    solver.scopesOf.and.callFake(t => (t === 'material' ? ['cell', 'column', 'layer', 'cube'] : t === 'view' ? [] : ['cell', 'cube', 'side']));
    solver.depth.and.returnValue(0);
    solver.divisions.and.callFake(() => divisions);
    solver.setup.and.returnValue({ materials } as unknown as SolverSetupDto);
    solver.activeMaterial.and.returnValue('rubber');
    solver.loadedFaceCount.and.returnValue(12);
    solver.fixedFaceCount.and.returnValue(8);
    solver.isFixedAuto.and.callFake(() => auto);
    solver.result.and.callFake(() => result);
    solver.display.and.callFake(() => display);
    solver.showInner.and.returnValue(false);
    TestBed.configureTestingModule({ providers: [{ provide: SolverService, useValue: solver }] });
    component = TestBed.runInInjectionContext(() => new SolverOverlayComponent());
    component.sessionId = 1;
  });

  describe('the tool', () => {
    it('offers View, Load, Fix and Material, and switches between them', () => {
      expect(component.tools.map(t => t.tool)).toEqual(['view', 'load', 'fix', 'material']);
      expect(TOOLS.every(t => t.label.length > 0 && t.title.length > 0)).toBeTrue();
      expect(component.tool()).toBe('view');

      component.setTool('fix');

      expect(solver.setTool).toHaveBeenCalledWith(1, 'fix');
    });

    it('offers the scopes of the tool: none for View, three for faces, four for materials', () => {
      expect(component.scopes()).toEqual([]);
      tool = 'load';
      expect(component.scopes().map(s => s.scope)).toEqual(['cell', 'cube', 'side']);
      tool = 'material';
      expect(component.scopes().map(s => s.scope)).toEqual(['cell', 'column', 'layer', 'cube']);
      expect(component.scopes().every(s => s.label.length > 0 && s.title.length > 0)).toBeTrue();
    });

    it('tracks the scope buttons by scope so they survive change detection', () => {
      expect(component.trackScope(0, { scope: 'layer' })).toBe('layer');
    });

    it('sets the scope', () => {
      component.setScope('cube');

      expect(solver.setScope).toHaveBeenCalledWith(1, 'cube');
    });
  });

  describe('the depth', () => {
    it('is offered for the Material tool with the one-element or layer scope, when a cube is cut', () => {
      expect(component.hasDepth()).toBeFalse();
      tool = 'material';
      expect(component.hasDepth()).toBeTrue();
      scope = 'layer';
      expect(component.hasDepth()).toBeTrue();
      scope = 'column';
      expect(component.hasDepth()).toBeFalse();
      scope = 'cube';
      expect(component.hasDepth()).toBeFalse();
      scope = 'cell';
      divisions = [1, 1, 1];
      expect(component.hasDepth()).toBeFalse();
    });

    it('steps deeper and back', () => {
      solver.depth.and.returnValue(1);

      component.deeper(1);
      component.deeper(-1);

      expect(solver.setDepth.calls.allArgs()).toEqual([[1, 2], [1, 0]]);
    });
  });

  describe('the palette', () => {
    it('shows only for the Material tool and paints with the chosen material', () => {
      expect(component.isMaterialTool()).toBeFalse();
      tool = 'material';
      expect(component.isMaterialTool()).toBeTrue();
      expect(component.materials().map(m => m.name)).toEqual(['steel', 'rubber']);
      expect(component.activeMaterial()).toBe('rubber');

      component.setActiveMaterial('steel');

      expect(solver.setActiveMaterial).toHaveBeenCalledWith(1, 'steel');
      expect(component.colorOf('steel')).toBe('#7da7d9');
    });

    it('has no materials before the set-up arrives', () => {
      solver.setup.and.returnValue(null);

      expect(component.materials()).toEqual([]);
    });
  });

  it('says what a click does with the chosen tool', () => {
    const hints = (['view', 'load', 'fix', 'material'] as Tool[]).map(t => {
      tool = t;
      return component.hint();
    });

    expect(new Set(hints).size).toBe(4);
    expect(hints[1]).toContain('навантажити');
    expect(hints[3]).toContain('пофарбувати');
  });

  it('legend of the marked faces: how many small faces are pressed and clamped, and "(авто)" for the automatic clamping', () => {
    expect(component.loadedText()).toBe('12 граней СЕ');
    expect(component.fixedText()).toBe('8 граней СЕ');
    auto = true;
    expect(component.fixedText()).toBe('8 граней СЕ (авто)');
  });

  describe('see-through', () => {
    it('shows the opacity in percent and sets it from the slider and from the presets', () => {
      display.opacity = 0.37;
      expect(component.opacityPercent()).toBe(37);

      component.onOpacity({ target: { value: '60' } } as unknown as Event);
      component.onOpacity({ target: { value: 'x' } } as unknown as Event);
      component.setOpacityPercent(15);

      expect(solver.setOpacity.calls.allArgs()).toEqual([[1, 0.6], [1, 0.15]]);
      expect(component.opacityPresets).toEqual([100, 70, 40, 15]);
    });

    it('switches the inner faces', () => {
      expect(component.showInner()).toBeFalse();

      component.toggleInner();

      expect(solver.setShowInner).toHaveBeenCalledWith(1, true);
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
      expect(legend.min).toBe('0.000 МПа');
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
