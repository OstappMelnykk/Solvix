import { TestBed } from '@angular/core/testing';
import { QualityControlsComponent } from './quality-controls.component';
import { SolverService } from '../../../state/solver.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { ActiveWorldService } from '../../../state/active-world.service';
import { SOLVER_WORLD_INDEX } from '../../../config/app-settings';
import { SolverElementReportDto, SolverQualityDto, SolverQualityReportDto } from '../../../api/solver-api.service';
import { buildConsensus } from '../../../geometry/quality-grading';
import { linkedPairState } from '../../../geometry/mesh-state.fixture.spec';

describe('QualityControlsComponent', () => {
  const grades = { excellent: 2, good: 0, acceptable: 0, poor: 1, invalid: 0 };
  const profile = (id: string, name: string): SolverQualityDto => ({
    id, name, source: `source of ${name}`, note: '', elements: 3, grades, worst: { aspectRatio: 12 },
    limits: [{ key: 'aspectRatio', label: 'Витягнутість', short: 'Витягнутість', tech: 'Aspect ratio', hint: 'довге ребро до короткого', higherIsBetter: false, levels: 2, bounds: [10], unit: '', decimals: 1, kind: 'plain' }],
    flagged: [{ hex: 0, ex: 0, ey: 0, ez: 0, grade: 'poor', values: { aspectRatio: 12 } }]
  });
  const report: SolverQualityReportDto = { profiles: [profile('solvix', 'Solvix'), profile('abaqus', 'Abaqus/CAE')] };
  const detail: SolverElementReportDto = {
    hex: 0, ex: 0, ey: 0, ez: 0,
    profiles: [{ id: 'solvix', grade: 'poor', values: { aspectRatio: 12 } }, { id: 'abaqus', grade: 'excellent', values: { aspectRatio: 6 } }]
  };

  let solver: jasmine.SpyObj<SolverService>;
  let world: jasmine.SpyObj<ActiveWorldService>;
  let current: string;
  let picked: { hex: number; ex: number; ey: number; ez: number } | null;

  beforeEach(() => {
    current = 'consensus';
    picked = null;
    solver = jasmine.createSpyObj<SolverService>('SolverService', [
      'quality', 'qualityReport', 'qualityProfile', 'setQualityProfile', 'qualityMetric', 'setQualityMetric', 'qualityPick', 'setQualityPick', 'qualityDetail', 'ensureQuality', 'divisions'
    ]);
    solver.qualityReport.and.returnValue(report);
    solver.qualityProfile.and.callFake(() => current);
    solver.quality.and.callFake(() => (current === 'consensus' ? buildConsensus(report) : report.profiles.find(p => p.id === current)!));
    solver.qualityMetric.and.returnValue('grade');
    solver.qualityPick.and.callFake(() => picked);
    solver.qualityDetail.and.callFake(() => (picked ? detail : null));
    solver.divisions.and.returnValue([1, 1, 1]);
    solver.setQualityProfile.and.callFake((_s, id) => (current = id));
    solver.setQualityPick.and.callFake((_s, p) => (picked = p));
    const editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['getState']);
    editor.getState.and.callFake(() => linkedPairState());
    world = jasmine.createSpyObj<ActiveWorldService>('ActiveWorldService', ['selectCurrentWorld']);
    TestBed.configureTestingModule({
      providers: [{ provide: SolverService, useValue: solver }, { provide: MeshEditorService, useValue: editor }, { provide: ActiveWorldService, useValue: world }]
    });
  });

  const render = () => {
    const fixture = TestBed.createComponent(QualityControlsComponent);
    fixture.componentRef.setInput('sessionId', 1);
    fixture.detectChanges();
    return fixture;
  };
  const pills = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>('.pill'));
  const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ');

  it('has five numbered sections with headers of their own', () => {
    const root = render().nativeElement as HTMLElement;

    expect(Array.from(root.querySelectorAll('.section__title')).map(h => text(h).trim())).toEqual([
      '1Чи можна рахувати', '2За яким стандартом', '3Що показує сцена', '4Уся сітка', '5Вибраний елемент'
    ]);
    expect(root.textContent).not.toContain('Проблемні елементи');
    expect(root.textContent).not.toContain('Консенсус');
  });

  it('lists the overall result first and each standard after it, with the share of elements it accepts', () => {
    const root = render().nativeElement as HTMLElement;

    expect(pills(root).map(b => b.querySelector('.pill__name')!.textContent)).toEqual(['Загальний результат', 'Solvix', 'Abaqus/CAE']);
    expect(pills(root)[1].querySelector('.pill__percent')!.textContent).toBe('67%');         // 2 of 3 elements are accepted
  });

  it('keeps the buttons themselves between change-detection passes, so a click is not lost (the 3D canvas triggers a pass every frame)', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    const before = pills(root);

    fixture.detectChanges();
    fixture.detectChanges();

    expect(pills(root).every((b, i) => b === before[i])).toBeTrue();
  });

  it('switches the standard on a click and lists that standard\'s measures with their limits', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;

    pills(root)[2].click();
    fixture.detectChanges();

    expect(solver.setQualityProfile).toHaveBeenCalledWith(1, 'abaqus');
    expect(pills(root)[2].classList).toContain('pill--on');
    expect(text(root)).toContain('source of Abaqus/CAE');
    expect(text(root)).toContain('Допустимо: не більше 10');
    expect(text(root)).toContain('1 із 3 елементів не приймаються');
  });

  it('always has the way to the solver, and says what to expect', () => {
    const fixture = render();
    const go = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.go')!;

    expect(text(go)).toContain('Перейти до розрахунку');
    go.click();

    expect(world.selectCurrentWorld).toHaveBeenCalledWith(SOLVER_WORLD_INDEX);
  });

  it('asks the user to click on the scene when nothing is picked, and shows every standard\'s verdict for a picked element', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    expect(text(root)).toContain('Клікніть на куб на сцені');

    picked = { hex: 0, ex: 0, ey: 0, ez: 0 };
    fixture.detectChanges();

    expect(text(root.querySelector('.picked__head')!)).toContain('Куб 0');
    const verdicts = Array.from(root.querySelectorAll('.verdict')).map(v => text(v).trim());
    expect(verdicts).toEqual(['Загальний результат: Приймається', 'Solvix: Не приймається', 'Abaqus/CAE: Приймається']);
  });

  it('for the overall result lists what exactly fails, and for a standard all its measures of the picked element', () => {
    picked = { hex: 0, ex: 0, ey: 0, ez: 0 };
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;

    expect(text(root)).toContain('Що саме не проходить');
    expect(text(root)).toContain('Solvix');

    pills(root)[2].click();                                  // Abaqus accepts it: its measure is shown, passing
    fixture.detectChanges();
    expect(root.querySelector('.picked__head ~ .measure .measure__mark--ok')).not.toBeNull();
  });

  it('picks the worst element for a measure that fails, and clears the pick', () => {
    current = 'solvix';
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;

    Array.from(root.querySelectorAll<HTMLButtonElement>('.link')).find(b => b.textContent!.includes('Показати'))!.click();

    expect(solver.setQualityPick).toHaveBeenCalledWith(1, { hex: 0, ex: 0, ey: 0, ez: 0 });
  });
});
