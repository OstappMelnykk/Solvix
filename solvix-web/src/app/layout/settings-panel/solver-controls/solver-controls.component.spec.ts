import { TestBed } from '@angular/core/testing';
import { SolverControlsComponent } from './solver-controls.component';
import { SolverService } from '../../../state/solver.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { MeshEditorSelectionService } from '../../../state/mesh-editor-selection.service';
import { SolverJobDto, SolverResultDto, SolverSetupDto, SolverValidationDto } from '../../../api/solver-api.service';
import { linkedPairState } from '../../../geometry/mesh-state.fixture.spec';

describe('SolverControlsComponent', () => {
  let solver: jasmine.SpyObj<SolverService>;
  let selection: MeshEditorSelectionService;
  let component: SolverControlsComponent;
  let setup: SolverSetupDto | null;
  let job: SolverJobDto;
  let result: SolverResultDto | null;
  let validation: SolverValidationDto | null;
  let display: { field: 'none' | 'vonMises' | 'displacement'; deformationScale: number };

  beforeEach(() => {
    setup = {
      version: 0,
      materials: [
        { name: 'steel', label: 'Сталь', e: 2.1e11, nu: 0.3 },
        { name: 'rubber', label: 'Гума', e: 1e7, nu: 0.45 }
      ],
      defaultMaterial: 'steel',
      hexMaterials: { '1': 'rubber' },
      fixed: [{ hex: 0, face: 'XMinus' }],
      loads: [{ hex: 1, face: 'XPlus', pressure: 2e6 }]
    };
    job = { state: 'idle', progress: 0, stage: '', error: null, ticket: 0 };
    result = null;
    validation = null;
    display = { field: 'vonMises', deformationScale: 1 };
    solver = jasmine.createSpyObj<SolverService>('SolverService', [
      'setup', 'validation', 'job', 'result', 'display', 'isRunning', 'isFixed', 'pressureOn', 'setDefaultMaterial', 'setMaterialOfSelection',
      'fixPickedFace', 'loadPickedFace', 'fixSide', 'loadSide', 'clearSetup', 'upsertMaterial', 'validate', 'solve', 'cancel', 'setField', 'setDeformationScale', 'clearResult'
    ]);
    solver.setup.and.callFake(() => setup);
    solver.validation.and.callFake(() => validation);
    solver.job.and.callFake(() => job);
    solver.result.and.callFake(() => result);
    solver.display.and.callFake(() => display);
    solver.isRunning.and.callFake(() => job.state === 'running');
    solver.isFixed.and.callFake((_s, hex, face) => !!setup?.fixed.some(f => f.hex === hex && f.face === face));
    solver.pressureOn.and.callFake((_s, hex, face) => setup?.loads.find(l => l.hex === hex && l.face === face)?.pressure ?? null);
    solver.solve.and.resolveTo();
    const editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['getState']);
    editor.getState.and.callFake(() => linkedPairState());
    TestBed.configureTestingModule({ providers: [{ provide: SolverService, useValue: solver }, { provide: MeshEditorService, useValue: editor }] });
    selection = TestBed.inject(MeshEditorSelectionService);
    component = TestBed.runInInjectionContext(() => new SolverControlsComponent());
    component.sessionId = 1;
  });

  it('summarises the set-up: cubes, clamped and pressed faces, and how many cubes have which material', () => {
    expect(component.hexCount()).toBe(2);
    expect(component.fixedCount()).toBe(1);
    expect(component.loadedCount()).toBe(1);
    expect(component.materialsInUse()).toEqual(['Сталь: 1', 'Гума: 1']);
    expect(component.labelOf('rubber')).toBe('Гума');
    expect(component.labelOf('unknown')).toBe('unknown');
  });

  it('copes with a set-up that has not arrived yet', () => {
    setup = null;

    expect(component.materials()).toEqual([]);
    expect(component.fixedCount()).toBe(0);
    expect(component.materialsInUse()).toEqual([]);
  });

  it('describes the picked face with what is set on it', () => {
    expect(component.hasPickedFace()).toBeFalse();
    selection.selectFace(1, { hex: 1, face: 'XPlus' });

    expect(component.hasPickedFace()).toBeTrue();
    expect(component.pickedFaceText()).toBe('Куб 1, XPlus · тиск 2 МПа');
    selection.selectFace(1, { hex: 0, face: 'XMinus' });
    expect(component.pickedFaceText()).toBe('Куб 0, XMinus · закріплена');
  });

  it('clamps and presses the picked face, converting MPa to Pa', () => {
    component.pressureMPa = 2.5;

    component.fixPicked(true);
    component.fixPicked(false);
    component.loadPicked(true);
    component.loadPicked(false);

    expect(solver.fixPickedFace.calls.allArgs()).toEqual([[1, true], [1, false]]);
    expect(solver.loadPickedFace.calls.allArgs()).toEqual([[1, 2.5e6], [1, null]]);
  });

  it('clamps and presses a whole side', () => {
    component.onSide({ target: { value: 'YPlus' } } as unknown as Event);
    component.pressureMPa = 3;

    component.fixSide(true);
    component.loadSide(true);
    component.loadSide(false);

    expect(solver.fixSide).toHaveBeenCalledWith(1, 'YPlus', true);
    expect(solver.loadSide.calls.allArgs()).toEqual([[1, 'YPlus', 3e6], [1, 'YPlus', null]]);
  });

  it('ignores a non-number in the pressure field', () => {
    component.pressureMPa = 4;

    component.onPressure({ target: { value: 'abc' } } as unknown as Event);

    expect(component.pressureMPa).toBe(4);
    component.onPressure({ target: { value: '7' } } as unknown as Event);
    expect(component.pressureMPa).toBe(7);
  });

  it('gives the picked cubes (or all) a material, and resets the select', () => {
    const select = { value: 'rubber' };

    component.onMaterialOfSelection({ target: select } as unknown as Event);

    expect(solver.setMaterialOfSelection).toHaveBeenCalledWith(1, 'rubber');
    expect(select.value).toBe('');
    component.onMaterialOfSelection({ target: { value: '' } } as unknown as Event);
    expect(solver.setMaterialOfSelection).toHaveBeenCalledTimes(1);
  });

  it('changes the default material', () => {
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

    it('is added in Pa with a generated name, and the form closes', () => {
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
      expect(component.newLabel).toBe('');
      expect(component.isMaterialFormOpen).toBeFalse();
    });

    it('is not added when invalid', () => {
      component.newLabel = '';

      component.addMaterial();

      expect(solver.upsertMaterial).not.toHaveBeenCalled();
    });

    it('reads the number fields and ignores junk', () => {
      component.onYoung({ target: { value: '200' } } as unknown as Event);
      component.onPoisson({ target: { value: '0.25' } } as unknown as Event);
      component.onYoung({ target: { value: 'x' } } as unknown as Event);

      expect(component.newYoungGPa).toBe(200);
      expect(component.newPoisson).toBe(0.25);
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

  describe('the solution', () => {
    beforeEach(() => {
      result = { ticket: 1, nodeIds: [0, 1], ux: [0, 0], uy: [0, 0], uz: [0, 0.002], vonMises: [0, 8e6], maxDisplacement: 0.002, maxVonMises: 8e6, elapsedSeconds: 1.234 };
    });

    it('says the maxima and the time', () => {
      expect(component.maxText()).toContain('8.000 МПа');
      expect(component.maxText()).toContain('2.000e-3');
      expect(component.elapsedText()).toBe('1.23 с');
    });

    it('gives the colour bar for the shown field and none for "materials"', () => {
      const bar = component.legend()!;
      expect(bar.min).toBe('0');
      expect(bar.max).toBe('8.000 МПа');
      expect(bar.gradient).toContain('linear-gradient');

      display = { field: 'displacement', deformationScale: 1 };
      expect(component.legend()!.max).toBe('2.000e-3');
      display = { field: 'none', deformationScale: 1 };
      expect(component.legend()).toBeNull();
    });

    it('switches the field and the deformation, ignoring a bad scale', () => {
      component.onField({ target: { value: 'displacement' } } as unknown as Event);
      component.onScale({ target: { value: '25' } } as unknown as Event);
      component.onScale({ target: { value: 'x' } } as unknown as Event);

      expect(solver.setField).toHaveBeenCalledWith(1, 'displacement');
      expect(solver.setDeformationScale.calls.allArgs()).toEqual([[1, 25]]);
    });

    it('removes the result', () => {
      component.clearResult();

      expect(solver.clearResult).toHaveBeenCalledWith(1);
    });

    it('has nothing to say before there is a result', () => {
      result = null;

      expect(component.maxText()).toBe('');
      expect(component.elapsedText()).toBe('');
      expect(component.legend()).toBeNull();
    });
  });

  it('resets the set-up', () => {
    component.clearSetup();

    expect(solver.clearSetup).toHaveBeenCalledWith(1);
  });
});
