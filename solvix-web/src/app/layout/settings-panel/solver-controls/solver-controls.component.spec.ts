import { TestBed } from '@angular/core/testing';
import { SolverControlsComponent } from './solver-controls.component';
import { SolverService } from '../../../state/solver.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { SolverJobDto, SolverResultDto, SolverSetupDto } from '../../../api/solver-api.service';
import { linkedPairState } from '../../../geometry/mesh-state.fixture.spec';

describe('SolverControlsComponent', () => {
  let solver: jasmine.SpyObj<SolverService>;
  let component: SolverControlsComponent;
  let setup: SolverSetupDto | null;
  let job: SolverJobDto;
  let result: SolverResultDto | null;
  let display: { field: 'none' | 'vonMises' | 'displacement'; deformationScale: number; opacity: number; colorMax: number | null; edges: boolean; vectors: boolean };
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
    display = { field: 'vonMises', deformationScale: 1, opacity: 1, colorMax: null, edges: true, vectors: true };
    solver = jasmine.createSpyObj<SolverService>('SolverService', [
      'setup', 'job', 'result', 'display', 'isRunning', 'divisions', 'setDivisions', 'setDefaultMaterial', 'upsertMaterial',
      'layers', 'layerMaterial', 'setLayerMaterial', 'quality', 'qualityReport', 'solvixQuality', 'ensureQuality', 'refreshQuality',
      'activeMaterial', 'setActiveMaterial', 'tool', 'setTool', 'materialCounts', 'isHidden', 'toggleHidden', 'fillAll',
      'pressure', 'setPressure', 'applyPressureToAll', 'loadSide', 'fixedSide', 'isFixedAuto', 'selectLoadSide', 'selectFixedSide', 'loadedFaceCount', 'fixedFaceCount',
      'clearSetup', 'removeMaterial', 'solve', 'cancel', 'setField', 'clearResult'
    ]);
    solver.setup.and.callFake(() => setup);
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
    solver.qualityReport.and.returnValue(null);
    solver.solvixQuality.and.returnValue(null);
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
    it('shows the number of elements the division makes (the division itself is set in the Real World)', () => {
      expect(component.divisions()).toEqual([2, 1, 3]);
      expect(component.hexCount()).toBe(2);
      expect(component.elementCount()).toBe(2 * 2 * 1 * 3);
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

      it('an existing material is edited: the form takes its values and saving puts them back under its own name', () => {
        const steel = { name: 'steel', label: 'Сталь', e: 2.1e11, nu: 0.3, color: '#445566' };

        component.startEdit(steel, new Event('click'));
        expect(component.isMaterialFormOpen).toBeTrue();
        expect(component.editingName).toBe('steel');
        expect(component.newLabel).toBe('Сталь');
        expect(component.newYoungGPa).toBe(210);
        expect(component.newPoisson).toBe(0.3);
        expect(component.newColor).toBe('#445566');

        component.newYoungGPa = 190;
        component.newColor = '#aabbcc';
        component.addMaterial();

        expect(solver.upsertMaterial).toHaveBeenCalledWith(1, { name: 'steel', label: 'Сталь', e: 190e9, nu: 0.3, color: '#aabbcc' });
        expect(component.editingName).toBeNull();
        expect(component.isMaterialFormOpen).toBeFalse();
      });

      it('a material is deleted from its edit form, except the default one', () => {
        component.startEdit({ name: 'rubber', label: 'Гума', e: 1e7, nu: 0.45 }, new Event('click'));
        expect(component.canRemoveEdited()).toBeTrue();
        component.removeEdited();
        expect(solver.removeMaterial).toHaveBeenCalledWith(1, 'rubber');
        expect(component.editingName).toBeNull();

        solver.removeMaterial.calls.reset();
        component.startEdit({ name: component.defaultMaterial(), label: 'Основний', e: 1e9, nu: 0.3 }, new Event('click'));
        expect(component.canRemoveEdited()).toBeFalse();
        component.removeEdited();
        expect(solver.removeMaterial).not.toHaveBeenCalled();
      });

      it('editing can be cancelled without sending anything', () => {
        component.startEdit({ name: 'steel', label: 'Сталь', e: 2.1e11, nu: 0.3 }, new Event('click'));
        component.cancelEdit();

        expect(component.editingName).toBeNull();
        expect(component.isMaterialFormOpen).toBeFalse();
        expect(solver.upsertMaterial).not.toHaveBeenCalled();
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
    it('sends Pn as typed, in Pa, and ignores junk', () => {
      component.onPressure({ target: { value: '-2500000' } } as unknown as Event);
      component.onPressure({ target: { value: 'x' } } as unknown as Event);

      expect(solver.setPressure.calls.allArgs()).toEqual([[1, -2.5e6]]);
      expect(component.pressure()).toBe(-1e6);
    });

    it('resets the set-up', () => {
      component.clearSetup();

      expect(solver.clearSetup).toHaveBeenCalledWith(1);
    });
  });

  describe('solving', () => {
    it('solves through the service', () => {
      component.solve();

      expect(solver.solve).toHaveBeenCalledWith(1);
    });

    describe('a mesh Solvix does not accept', () => {
      const solvix = (rejected: number, invalid: number) => ({
        id: 'solvix', name: 'Solvix', source: '', note: '', elements: 10,
        grades: { excellent: 10 - rejected - invalid, good: 0, acceptable: 0, poor: rejected, invalid },
        worst: {}, limits: [], flagged: []
      });

      it('solves whatever the quality of the mesh: the user decides', () => {
        for (const [rejected, invalid] of [[3, 0], [0, 2], [0, 0]]) {
          solver.solve.calls.reset();
          solver.solvixQuality.and.returnValue(solvix(rejected, invalid));
          component.solve();
          expect(solver.solve).toHaveBeenCalledWith(1);
        }
      });
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
    const q = (over: Record<string, number> = {}) => ({ id: 'solvix', name: 'Solvix', source: '', note: '', elements: 3, grades: { ...grades, ...over }, worst: {}, limits: [], flagged: [] });

    it('evaluates the mesh', () => {
      component.refreshQuality();

      expect(solver.refreshQuality).toHaveBeenCalledWith(1);
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
