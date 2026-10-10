import { TestBed } from '@angular/core/testing';
import { SolverControlsComponent } from './solver-controls.component';
import { SolverService } from '../../../state/solver.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { SolverJobDto, SolverResultDto, SolverSetupDto, SolverValidationDto } from '../../../api/solver-api.service';
import { linkedPairState } from '../../../geometry/mesh-state.fixture.spec';

describe('SolverControlsComponent', () => {
  let solver: jasmine.SpyObj<SolverService>;
  let component: SolverControlsComponent;
  let setup: SolverSetupDto | null;
  let job: SolverJobDto;
  let result: SolverResultDto | null;
  let validation: SolverValidationDto | null;
  let display: { field: 'none' | 'vonMises' | 'displacement'; deformationScale: number; opacity: number; colorMax: number | null; edges: boolean };
  let divisions: number[];
  let pressure: number;
  let loadSide: string | null;
  let fixedSide: string | null;
  let auto: boolean;

  beforeEach(() => {
    divisions = [2, 1, 3];
    pressure = -1e6;
    loadSide = null;
    fixedSide = null;
    auto = false;
    setup = {
      version: 0,
      divisions,
      materials: [
        { name: 'steel', label: 'Сталь', e: 2.1e11, nu: 0.3 },
        { name: 'rubber', label: 'Гума', e: 1e7, nu: 0.45 }
      ],
      defaultMaterial: 'steel',
      hexMaterials: { '1': 'rubber' },
      elementMaterials: [],
      fixed: [],
      loads: []
    };
    job = { state: 'idle', progress: 0, stage: '', error: null, ticket: 0 };
    result = null;
    validation = null;
    display = { field: 'vonMises', deformationScale: 1, opacity: 1, colorMax: null, edges: true };
    solver = jasmine.createSpyObj<SolverService>('SolverService', [
      'setup', 'validation', 'job', 'result', 'display', 'isRunning', 'divisions', 'setDivisions', 'setDefaultMaterial', 'upsertMaterial',
      'layers', 'layerMaterial', 'setLayerMaterial', 'quality', 'refreshQuality', 'showQuality', 'setShowQuality',
      'activeMaterial', 'setActiveMaterial', 'tool', 'setTool', 'materialCounts', 'isHidden', 'toggleHidden', 'fillAll',
      'pressure', 'setPressure', 'loadSide', 'fixedSide', 'isFixedAuto', 'selectLoadSide', 'selectFixedSide', 'loadedFaceCount', 'fixedFaceCount',
      'clearSetup', 'validate', 'solve', 'cancel', 'setField', 'clearResult'
    ]);
    solver.setup.and.callFake(() => setup);
    solver.validation.and.callFake(() => validation);
    solver.job.and.callFake(() => job);
    solver.result.and.callFake(() => result);
    solver.display.and.callFake(() => display);
    solver.isRunning.and.callFake(() => job.state === 'running');
    solver.divisions.and.callFake(() => divisions);
    solver.pressure.and.callFake(() => pressure);
    solver.loadSide.and.callFake(() => loadSide as never);
    solver.fixedSide.and.callFake(() => fixedSide as never);
    solver.isFixedAuto.and.callFake(() => auto);
    solver.loadedFaceCount.and.returnValue(7);
    solver.fixedFaceCount.and.returnValue(5);
    solver.solve.and.resolveTo();
    solver.activeMaterial.and.returnValue('rubber');
    solver.layers.and.returnValue([{ name: 'enamel', hexes: [0] }]);
    solver.layerMaterial.and.returnValue('steel');
    solver.quality.and.returnValue(null);
    solver.showQuality.and.returnValue(false);
    solver.tool.and.returnValue('view');
    solver.materialCounts.and.returnValue(new Map([['steel', 7], ['rubber', 3]]));
    solver.isHidden.and.callFake((_s, name) => name === 'rubber');
    const editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['getState']);
    editor.getState.and.callFake(() => linkedPairState());
    TestBed.configureTestingModule({ providers: [{ provide: SolverService, useValue: solver }, { provide: MeshEditorService, useValue: editor }] });
    component = TestBed.runInInjectionContext(() => new SolverControlsComponent());
    component.sessionId = 1;
  });

  describe('the mesh of small elements', () => {
    it('shows the division and the number of elements it makes', () => {
      expect(component.divisions()).toEqual([2, 1, 3]);
      expect(component.hexCount()).toBe(2);
      expect(component.elementCount()).toBe(2 * 2 * 1 * 3);
    });

    it('sends the changed axis with the others kept, clamped to 1..8, ignoring non-numbers', () => {
      const type = (axis: number, value: string) => component.onDivision(axis, { target: { value } } as unknown as Event);

      type(0, '4');
      type(1, '99');
      type(2, '0');
      type(0, '2.9');
      type(1, 'abc');

      expect(solver.setDivisions.calls.allArgs()).toEqual([[1, 4, 1, 3], [1, 2, 8, 3], [1, 2, 1, 1], [1, 2, 1, 3]]);
    });
  });

  describe('materials: a palette', () => {
    it('lists the library with the colour, the number of elements and whether it is hidden', () => {
      expect(component.materials().map(m => m.name)).toEqual(['steel', 'rubber']);
      expect(component.defaultMaterial()).toBe('steel');
      expect(component.activeMaterial()).toBe('rubber');
      expect(component.countOf('steel')).toBe(7);
      expect(component.countOf('nothing')).toBe(0);
      expect(component.isHidden('rubber')).toBeTrue();
      expect(component.isHidden('steel')).toBeFalse();
      expect(component.colorOf('rubber')).toBe('#e0605a');
    });

    it('copes with a set-up that has not arrived yet', () => {
      setup = null;

      expect(component.materials()).toEqual([]);
      expect(component.defaultMaterial()).toBe('');
    });

    it('choosing a material makes it the active one and switches to the tool that paints with it', () => {
      component.selectMaterial('steel');

      expect(solver.setActiveMaterial).toHaveBeenCalledWith(1, 'steel');
      expect(solver.setTool).toHaveBeenCalledWith(1, 'material');
    });

    it('does not switch the tool again when it already paints', () => {
      solver.tool.and.returnValue('material');

      component.selectMaterial('steel');

      expect(solver.setTool).not.toHaveBeenCalled();
    });

    it('the eye hides or shows a material without choosing it', () => {
      const event = jasmine.createSpyObj<Event>('Event', ['stopPropagation']);

      component.toggleHidden('steel', event);

      expect(event.stopPropagation).toHaveBeenCalled();
      expect(solver.toggleHidden).toHaveBeenCalledWith(1, 'steel');
      expect(solver.setActiveMaterial).not.toHaveBeenCalled();
    });

    it('fills the whole body with the active material, or sets it back to the main one', () => {
      component.fillAll();
      component.resetMaterials();

      expect(solver.fillAll.calls.allArgs()).toEqual([[1, 'rubber'], [1, 'steel']]);
    });

    it('changes the main material', () => {
      component.onDefaultMaterial({ target: { value: 'rubber' } } as unknown as Event);

      expect(solver.setDefaultMaterial).toHaveBeenCalledWith(1, 'rubber');
    });

    describe('a custom material', () => {
      it('needs a name, a positive modulus and a Poisson ratio below 0.5', () => {
        component.newLabel = '';
        expect(component.canAddMaterial()).toBeFalse();
        component.newLabel = 'Скло';
        expect(component.canAddMaterial()).toBeTrue();
        component.newYoungGPa = 0;
        expect(component.canAddMaterial()).toBeFalse();
        component.newYoungGPa = 70;
        component.newPoisson = 0.5;
        expect(component.canAddMaterial()).toBeFalse();
      });

      it('is added in Pa with a generated name, becomes the active one, and the form closes', () => {
        component.isMaterialFormOpen = true;
        component.newLabel = ' Скло ';
        component.newYoungGPa = 70;
        component.newPoisson = 0.22;

        component.addMaterial();

        const material = solver.upsertMaterial.calls.mostRecent().args[1];
        expect(material.label).toBe('Скло');
        expect(material.e).toBe(70e9);
        expect(material.nu).toBe(0.22);
        expect(material.name.startsWith('custom-')).toBeTrue();
        expect(solver.setActiveMaterial).toHaveBeenCalledWith(1, material.name);
        expect(component.newLabel).toBe('');
        expect(component.isMaterialFormOpen).toBeFalse();
      });

      it('is not added when invalid, and the number fields ignore junk', () => {
        component.newLabel = '';
        component.addMaterial();
        expect(solver.upsertMaterial).not.toHaveBeenCalled();

        component.onYoung({ target: { value: '200' } } as unknown as Event);
        component.onPoisson({ target: { value: '0.25' } } as unknown as Event);
        component.onYoung({ target: { value: 'x' } } as unknown as Event);
        expect(component.newYoungGPa).toBe(200);
        expect(component.newPoisson).toBe(0.25);
      });
    });
  });

  describe('the load and the clamping', () => {
    it('lists the six sides by the solver\'s names', () => {
      expect(component.sides.map(s => s.label)).toEqual(['Верх', 'Низ', 'Перед', 'Зад', 'Ліво', 'Право']);
      expect(component.sides.map(s => s.face)).toEqual(['ZPlus', 'ZMinus', 'YMinus', 'YPlus', 'XMinus', 'XPlus']);
    });

    it('sends Pn as typed, in Pa, and ignores junk', () => {
      component.onPressure({ target: { value: '-2500000' } } as unknown as Event);
      component.onPressure({ target: { value: 'x' } } as unknown as Event);

      expect(solver.setPressure.calls.allArgs()).toEqual([[1, -2.5e6]]);
      expect(component.pressure()).toBe(-1e6);
    });

    it('describes Pn: compression, tension or nothing', () => {
      expect(component.pressureHint()).toContain('стиск');
      pressure = 2e6;
      expect(component.pressureHint()).toContain('розтяг');
      pressure = 0;
      expect(component.pressureHint()).toBe('немає навантаження');
    });

    it('chooses the load side and the clamped side through the service', () => {
      component.selectLoadSide('ZPlus');
      component.selectFixedSide('ZMinus');

      expect(solver.selectLoadSide).toHaveBeenCalledWith(1, 'ZPlus');
      expect(solver.selectFixedSide).toHaveBeenCalledWith(1, 'ZMinus');
    });

    it('marks the active load side, the chosen clamped side, and - dashed - the automatic one', () => {
      loadSide = 'ZPlus';
      fixedSide = 'ZMinus';
      auto = true;
      expect(component.isLoadSide('ZPlus')).toBeTrue();
      expect(component.isLoadSide('ZMinus')).toBeFalse();
      expect(component.isFixedSide('ZMinus')).toBeFalse();
      expect(component.isFixedAutoSide('ZMinus')).toBeTrue();

      auto = false;
      expect(component.isFixedSide('ZMinus')).toBeTrue();
      expect(component.isFixedAutoSide('ZMinus')).toBeFalse();
    });

    it('says how many small faces are loaded and clamped, and when the clamping is automatic', () => {
      expect(component.loadedText()).toBe('Навантажено: 7 граней СЕ');
      expect(component.fixedText()).toBe('Закріплено: 5 граней');
      auto = true;
      expect(component.fixedText()).toBe('Закріплено: 5 граней (авто)');
      auto = false;
      solver.fixedFaceCount.and.returnValue(0);
      expect(component.fixedText()).toBe('Закріплено: нічого');
    });

    it('resets the set-up', () => {
      component.clearSetup();

      expect(solver.clearSetup).toHaveBeenCalledWith(1);
    });
  });

  describe('solving', () => {
    it('validates and solves through the service', () => {
      component.validate();
      component.solve();

      expect(solver.validate).toHaveBeenCalledWith(1);
      expect(solver.solve).toHaveBeenCalledWith(1);
    });

    it('shows the stage and percentage while running, and the reason when it fails', () => {
      job = { state: 'running', progress: 0.426, stage: 'Розв\'язання системи', error: null, ticket: 1 };
      expect(component.isRunning()).toBeTrue();
      expect(component.progressPercent()).toBe(43);
      expect(component.jobText()).toBe('Розв\'язання системи — 43%');

      job = { state: 'failed', progress: 0, stage: '', error: 'Закріпіть хоча б одну грань', ticket: 1 };
      expect(component.jobText()).toBe('Закріпіть хоча б одну грань');
      job = { state: 'cancelled', progress: 0, stage: '', error: null, ticket: 1 };
      expect(component.jobText()).toBe('Розрахунок скасовано');
      job = { state: 'done', progress: 1, stage: '', error: null, ticket: 1 };
      expect(component.jobText()).toBe('Розрахунок завершено');
      job = { state: 'idle', progress: 0, stage: '', error: null, ticket: 0 };
      expect(component.jobText()).toBe('');
    });

    it('cancels', () => {
      component.cancel();

      expect(solver.cancel).toHaveBeenCalledWith(1);
    });

    it('exposes the verdict of the validation', () => {
      validation = { canSolve: false, issues: [{ severity: 'error', message: 'Закріпіть' }] };

      expect(component.validation()!.issues[0].message).toBe('Закріпіть');
    });
  });

  describe('the results', () => {
    beforeEach(() => {
      result = {
        ticket: 1, divisions: [1, 1, 1], positions: [0, 0, 0, 1, 0, 0], hexIds: [0], gridNodes: [0, 1],
        ux: [0, 0], uy: [0, 0], uz: [-0.001, 0.002], vonMises: [1e5, 8e6], maxDisplacement: 0.002, maxVonMises: 8e6, elapsedSeconds: 1.234
      };
    });

    it('lists what the solver reports: min uz, max |u|, the von Mises range, nodes and time', () => {
      const rows = Object.fromEntries(component.summary().map(r => [r.label, r.value]));

      expect(rows['Min uz']).toBe('-1.0000e-3');
      expect(rows['Max |u|']).toBe('2.0000e-3');
      expect(rows['Max σ_vm']).toBe('8.000e+6 Па');
      expect(rows['Min σ_vm']).toBe('1.000e+5 Па');
      expect(rows['Вузлів СЕ']).toBe('2');
      expect(rows['Час']).toBe('1.23 с');
    });

    it('switches the shown field and removes the result', () => {
      component.onField({ target: { value: 'displacement' } } as unknown as Event);
      component.clearResult();

      expect(solver.setField).toHaveBeenCalledWith(1, 'displacement');
      expect(solver.clearResult).toHaveBeenCalledWith(1);
    });

    it('has nothing to show before there is a result', () => {
      result = null;

      expect(component.summary()).toEqual([]);
    });
  });

  describe('layers', () => {
    it('lists the layers with the material of each and sets one for the whole layer', () => {
      expect(component.layers()).toEqual([{ name: 'enamel', hexes: [0] }]);
      expect(component.layerMaterial('enamel')).toBe('steel');
      solver.layerMaterial.and.returnValue(null);
      expect(component.layerMaterial('enamel')).toBe('');

      component.onLayerMaterial('enamel', { target: { value: 'rubber' } } as unknown as Event);
      component.onLayerMaterial('enamel', { target: { value: '' } } as unknown as Event);

      expect(solver.setLayerMaterial.calls.allArgs()).toEqual([[1, 'enamel', 'rubber']]);
    });
  });

  describe('mesh quality', () => {
    const grades = { excellent: 3, good: 0, acceptable: 0, poor: 0, invalid: 0 };
    const q = (over: Record<string, number> = {}) => ({ elements: 3, grades: { ...grades, ...over }, worstScaledJacobian: 1, worstJacobianRatio: 1, worstAspectRatio: 1, worstSkewDegrees: 0, cubes: [], limits: [] });

    it('evaluates and switches the colouring', () => {
      component.refreshQuality();
      component.toggleQuality();

      expect(solver.refreshQuality).toHaveBeenCalledWith(1);
      expect(solver.setShowQuality).toHaveBeenCalledWith(1, true);
    });

    it('gives the verdict in one line, worst problem first', () => {
      expect(component.qualityVerdict()).toBe('');
      solver.quality.and.returnValue(q());
      expect(component.qualityVerdict()).toBe('Сітка якісна');
      solver.quality.and.returnValue(q({ acceptable: 1 }));
      expect(component.qualityVerdict()).toContain('середньої якості');
      solver.quality.and.returnValue(q({ acceptable: 1, poor: 2 }));
      expect(component.qualityVerdict()).toContain('погані елементи (2)');
      solver.quality.and.returnValue(q({ poor: 2, invalid: 1 }));
      expect(component.qualityVerdict()).toContain('неможливий');
    });

    it('has a label and a colour for every grade', () => {
      expect(component.gradeLabels.map(g => g.key)).toEqual(['excellent', 'good', 'acceptable', 'poor', 'invalid']);
      expect(component.gradeColor('excellent')).toBe('#2fbf4f');
      expect(component.gradeColor('invalid')).toBe('#e02b2b');
    });
  });
});
