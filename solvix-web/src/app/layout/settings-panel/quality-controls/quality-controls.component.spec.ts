import { TestBed } from '@angular/core/testing';
import { QualityControlsComponent } from './quality-controls.component';
import { SolverService } from '../../../state/solver.service';
import { ActiveWorldService } from '../../../state/active-world.service';
import { SOLVER_WORLD_INDEX } from '../../../config/app-settings';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { SolverElementReportDto, SolverQualityDto, SolverQualityReportDto } from '../../../api/solver-api.service';
import { buildConsensus } from '../../../geometry/quality-grading';
import { linkedPairState } from '../../../geometry/mesh-state.fixture.spec';

describe('QualityControlsComponent', () => {
  const grades = { excellent: 2, good: 0, acceptable: 0, poor: 1, invalid: 0 };
  const profile = (id: string, name: string): SolverQualityDto => ({
    id, name, source: `source of ${name}`, note: '', elements: 3, grades, worst: { aspectRatio: 12 },
    limits: [{ key: 'aspectRatio', label: 'Витягнутість', short: 'Витягнутість', tech: 'Aspect ratio', hint: '', higherIsBetter: false, levels: 2, bounds: [10], unit: '', decimals: 1, kind: 'plain' }],
    flagged: [{ hex: 0, ex: 0, ey: 0, ez: 0, grade: 'poor', values: { aspectRatio: 12 } }]
  });
  const report: SolverQualityReportDto = { profiles: [profile('solvix', 'Solvix'), profile('abaqus', 'Abaqus/CAE')] };

  const detail: SolverElementReportDto = {
    hex: 0, ex: 0, ey: 0, ez: 0,
    profiles: [{ id: 'solvix', grade: 'poor', values: { aspectRatio: 12 } }, { id: 'abaqus', grade: 'poor', values: { aspectRatio: 12 } }]
  };
  let picked: { hex: number; ex: number; ey: number; ez: number } | null;
  let solver: jasmine.SpyObj<SolverService>;
  let current: string;
  let world: jasmine.SpyObj<ActiveWorldService>;

  beforeEach(() => {
    current = 'consensus';
    picked = null;
    solver = jasmine.createSpyObj<SolverService>('SolverService', [
      'quality', 'qualityReport', 'qualityProfile', 'setQualityProfile', 'qualityMetric', 'setQualityMetric', 'qualityPick', 'setQualityPick', 'qualityDetail', 'marks', 'setMarks', 'ensureQuality', 'divisions'
    ]);
    solver.qualityReport.and.returnValue(report);
    solver.qualityProfile.and.callFake(() => current);
    solver.quality.and.callFake(() => (current === 'consensus' ? buildConsensus(report) : report.profiles.find(p => p.id === current)!));
    solver.qualityMetric.and.returnValue('grade');
    solver.marks.and.returnValue({ fixed: false, loads: true });
    solver.qualityDetail.and.callFake(() => (picked ? detail : null));
    solver.qualityPick.and.callFake(() => picked);
    solver.divisions.and.returnValue([1, 1, 1]);
    solver.setQualityProfile.and.callFake((_s, id) => (current = id));
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
  const buttons = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>('.standard'));

  it('lists the standards and the consensus, each with how many elements it rejects', () => {
    const root = render().nativeElement as HTMLElement;

    expect(buttons(root).map(b => b.querySelector('b')!.textContent)).toEqual(['Solvix', 'Abaqus/CAE', 'Загальний результат']);
    expect(buttons(root)[0].textContent).toContain('1');
  });

  it('keeps the buttons themselves between change-detection passes, so a click is not lost (the 3D canvas triggers a pass every frame)', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    const before = buttons(root);
    const rows = Array.from(root.querySelectorAll('.row'));

    fixture.detectChanges();
    fixture.detectChanges();

    expect(buttons(root).every((b, i) => b === before[i])).toBeTrue();
    expect(Array.from(root.querySelectorAll('.row')).every((r, i) => r === rows[i])).toBeTrue();
  });

  it('switches the standard on a click and shows that standard\'s limits', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;

    buttons(root)[1].click();
    fixture.detectChanges();

    expect(solver.setQualityProfile).toHaveBeenCalledWith(1, 'abaqus');
    expect(buttons(root)[1].classList).toContain('standard--on');
    expect(root.textContent).toContain('source of Abaqus/CAE');
    expect(root.textContent).toContain('Не проходить');
  });

  it('answers first whether the solver can be used, and takes the user there', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    const card = root.querySelector('.decision')!;

    // both standards reject the same element, but that is less than most of the five: go on with care
    expect(card.getAttribute('data-level')).toBe('caution');
    expect(card.textContent).toContain('Можна рахувати, з обережністю');
    (card.parentElement!.querySelector('.go') as HTMLButtonElement).click();

    expect(world.selectCurrentWorld).toHaveBeenCalledWith(SOLVER_WORLD_INDEX);
  });

  it('shows the elements that are rejected on request', () => {
    const fixture = render();
    const show = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.go')).find(b => b.textContent!.includes('проблемні'))!;

    show.click();

    expect(solver.setQualityProfile).toHaveBeenCalledWith(1, 'consensus');
    expect(solver.setQualityPick).toHaveBeenCalledWith(1, { hex: 0, ex: 0, ey: 0, ez: 0 });
  });

  it('has no list of problem elements; the user clicks on the scene instead and is told so', () => {
    const root = render().nativeElement as HTMLElement;

    expect(root.textContent).not.toContain('Проблемні елементи');
    expect(root.querySelector('.row')).toBeNull();
    expect(root.textContent).toContain('Клікніть на куб на сцені');
  });

  it('shows everything about the clicked element: the verdict and every measure of the standard, with its value and limit', () => {
    current = 'solvix';
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    picked = { hex: 0, ex: 0, ey: 0, ez: 0 };

    fixture.detectChanges();

    const text = (root.querySelector('.picked__head')!.parentElement!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Куб 0');
    expect(text).toContain('Витягнутість');
    expect(text).toContain('12.0');
    expect(text).toContain('Допустимо: не більше 10');
    expect(root.querySelector('.measure--bad')).not.toBeNull();
  });

  it('for the overall result shows the element by every standard and how many reject it', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    picked = { hex: 0, ex: 0, ey: 0, ez: 0 };

    fixture.detectChanges();

    expect(Array.from(root.querySelectorAll('.detail__head b')).map(b => b.textContent)).toEqual(['Solvix', 'Abaqus/CAE']);
    expect(root.querySelector('.by')!.textContent).toContain('2');
  });

  it('clears the pick with the same element picked again', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    picked = { hex: 0, ex: 0, ey: 0, ez: 0 };
    fixture.detectChanges();

    root.querySelector<HTMLButtonElement>('.picked__head .link')!.click();

    expect(solver.setQualityPick).toHaveBeenCalledWith(1, { hex: 0, ex: 0, ey: 0, ez: 0 });
  });

  it('puts the overall grade on a row of its own and the single measures under it, each with its full name', () => {
    current = 'solvix';
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    const grade = root.querySelector<HTMLButtonElement>('.choice__grade')!;
    const measures = Array.from(root.querySelectorAll<HTMLButtonElement>('.choice__measures .choice__btn'));

    expect(grade.textContent!.trim()).toBe('Оцінка');
    expect(grade.parentElement!.classList).toContain('choice');
    expect(measures.map(m => (m.textContent ?? '').replace(/\s+/g, ' ').trim())).toEqual(['ВитягнутістьAspect ratio']);
    expect(measures.some(m => m.contains(grade))).toBeFalse();

    measures[0].click();
    expect(solver.setQualityMetric).toHaveBeenCalledWith(1, 'aspectRatio');
    grade.click();
    expect(solver.setQualityMetric).toHaveBeenCalledWith(1, 'grade');
  });

  it('knows only accepted or not for a standard - the finer grades are not shown', () => {
    current = 'abaqus';
    const root = render().nativeElement as HTMLElement;

    expect(Array.from(root.querySelectorAll('.legend span')).map(l => (l.textContent ?? '').trim())).toEqual(['Приймається за Abaqus/CAE', 'Не приймається за Abaqus/CAE']);
    expect(root.textContent).not.toMatch(/відмінн|добр|прийнятн|невалідн/i);
  });

  it('adds "disputed" for the overall result, where some standards reject an element and the others accept it', () => {
    current = 'consensus';
    const root = render().nativeElement as HTMLElement;

    expect(Array.from(root.querySelectorAll('.legend span')).map(l => (l.textContent ?? '').trim())).toEqual([
      'Приймається всіма стандартами', 'Спірно: один-два стандарти не приймають', 'Не приймається: три й більше стандартів'
    ]);
  });

  it('has a switch for the supports and one for the loads, each in its own state', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    const boxes = Array.from(root.querySelectorAll<HTMLInputElement>('.mark input'));

    expect(boxes.map(b => b.checked)).toEqual([false, true]);

    boxes[0].click();
    boxes[1].click();

    expect(solver.setMarks).toHaveBeenCalledWith(1, 'quality', 'fixed', true);
    expect(solver.setMarks).toHaveBeenCalledWith(1, 'quality', 'loads', false);
  });

  it('lays the conclusion out: a banner with the verdict, the figure, who rejects, and what to do', () => {
    const root = render().nativeElement as HTMLElement;
    const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    expect(text(root.querySelector('.decision__banner'))).toContain('Можна рахувати, з обережністю');
    expect(text(root.querySelector('.decision__stat'))).toContain('1 із 3 елементів (33%)');
    expect(Array.from(root.querySelectorAll('.decision__who .chip')).map(c => text(c))).toEqual(['Solvix 1', 'Abaqus/CAE 1']);
    expect(text(root.querySelector('.decision__advice'))).toContain('Перевірте їх на карті якості');
    expect(Array.from(root.querySelectorAll('.decision__actions .go')).map(b => text(b))).toEqual(['Перейти до розрахунку →', 'Показати проблемні елементи']);
  });
});
