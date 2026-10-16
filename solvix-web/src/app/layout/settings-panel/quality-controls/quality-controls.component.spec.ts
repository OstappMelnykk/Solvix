import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { QualityControlsComponent } from './quality-controls.component';
import { SolverService } from '../../../state/solver.service';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { ActiveWorldService } from '../../../state/active-world.service';
import { SOLVER_WORLD_INDEX } from '../../../config/app-settings';
import { SolverElementReportDto, SolverQualityDto, SolverQualityLimitDto, SolverQualityReportDto } from '../../../api/solver-api.service';
import { linkedPairState } from '../../../geometry/mesh-state.fixture.spec';

describe('QualityControlsComponent', () => {
  const aspect: SolverQualityLimitDto = {
    key: 'aspectRatio', label: 'Витягнутість', short: 'Витягнутість', tech: 'Aspect ratio', hint: 'довге ребро до короткого', higherIsBetter: false, levels: 2,
    bounds: [20], unit: '', decimals: 1, kind: 'plain', errorBound: 1_000_000
  };
  const profile = (id: string, name: string, rejected: number): SolverQualityDto => ({
    id, name, source: `source of ${name}`, note: `note of ${name}`, elements: 4,
    grades: { excellent: 4 - rejected, good: 0, acceptable: 0, poor: rejected, invalid: 0 }, worst: { aspectRatio: 25 }, limits: [aspect],
    flagged: Array.from({ length: rejected }, (_, i) => ({ hex: i, ex: 0, ey: 0, ez: 0, grade: 'poor' as const, values: { aspectRatio: 25 } }))
  });
  const report: SolverQualityReportDto = { profiles: [profile('solvix', 'Solvix', 1), profile('abaqus', 'Abaqus/CAE', 0), profile('cubit', 'Cubit (Sandia)', 3)] };
  const detail: SolverElementReportDto = {
    hex: 0, ex: 0, ey: 0, ez: 0,
    profiles: [{ id: 'solvix', grade: 'poor', values: { aspectRatio: 25 } }, { id: 'abaqus', grade: 'excellent', values: { aspectRatio: 25 } }]
  };

  let solver: jasmine.SpyObj<SolverService>;
  let world: jasmine.SpyObj<ActiveWorldService>;
  let compare: string | null;
  let picked: { hex: number; ex: number; ey: number; ez: number } | null;

  beforeEach(() => {
    compare = null;
    picked = null;
    solver = jasmine.createSpyObj<SolverService>('SolverService', [
      'quality', 'solvixQuality', 'qualityReport', 'qualityCompare', 'setQualityCompare', 'qualityMetric', 'setQualityMetric', 'qualityPick', 'setQualityPick',
      'qualityDetail', 'marks', 'setMarks', 'ensureQuality', 'divisions'
    ]);
    solver.qualityReport.and.returnValue(report);
    solver.solvixQuality.and.returnValue(report.profiles[0]);
    solver.qualityCompare.and.callFake(() => compare);
    solver.quality.and.callFake(() => report.profiles.find(p => p.id === (compare ?? 'solvix'))!);
    solver.qualityMetric.and.returnValue('grade');
    solver.qualityPick.and.callFake(() => picked);
    solver.qualityDetail.and.callFake(() => (picked ? detail : null));
    solver.marks.and.returnValue({ fixed: false, loads: true });
    solver.divisions.and.returnValue([1, 1, 1]);
    solver.setQualityCompare.and.callFake((_s, id) => (compare = id));
    solver.setQualityPick.and.callFake((_s, p) => (picked = p));
    const editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['getState', 'smooth']);
    Object.defineProperty(editor, 'busy', { get: () => signal(false) });
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
  const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const link = (root: HTMLElement, label: string) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b => text(b).includes(label))!;

  it('has its sections under headers of their own, and no list of problem elements, no vote of the standards', () => {
    const root = render().nativeElement as HTMLElement;

    expect(Array.from(root.querySelectorAll('h5')).map(h => text(h))).toEqual([
      'Критерії Solvix', 'Фарбувати сцену за', 'Вигляд', 'Подивитись усередину', 'Інші інструменти'
    ]);
    expect(root.textContent).not.toMatch(/Проблемні елементи|Консенсус|Загальний результат/);
  });

  it('says by Solvix\'s criterion alone whether the mesh is accepted, with how many elements fail and by which measure', () => {
    const root = render().nativeElement as HTMLElement;

    expect(text(root.querySelector('.go--wide'))).toContain('Сітка не приймається');
    expect(text(root.querySelector('.go--wide'))).toContain('(1 із 4, 25%)');
  });

  it('blocks the way to the solver (disabled, red) while the mesh is not accepted', () => {
    const root = render().nativeElement as HTMLElement;
    const go = root.querySelector<HTMLButtonElement>('.go--wide')!;

    expect(text(go)).toContain('Сітка не приймається');
    expect(go.disabled).toBeTrue();
    expect(go.classList).toContain('go--no');
  });

  it('shows each measure with its limit, the worst value, pass or fail', () => {
    const root = render().nativeElement as HTMLElement;
    const gauge = text(root.querySelector('.gauge'));

    expect(text(root.querySelectorAll('.part')[1])).not.toContain('source of Solvix');    // the long description is not shown
    expect(gauge).toContain('Aspect ratio');
    expect(gauge).toContain('25.0');
    expect(gauge).not.toContain('Допустимо');
  });

  it('walks along the bad elements and, with the cut on, moves the plane to the one it picks', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    const component = fixture.componentInstance;
    expect(component.badElements().length).toBe(1);
    expect(text(root.querySelector('.walk'))).toContain('Проблемних елементів: 1');

    component.walk(1);
    expect(solver.setQualityPick).toHaveBeenCalledWith(1, { hex: 0, ex: 0, ey: 0, ez: 0 });

    solver.setQualityPick.calls.reset();
    component.toggleSection();
    component.setSectionAxis(0);
    component.walk(1);                                           // already on it: it is not picked again (that would unpick it)
    expect(solver.setQualityPick).not.toHaveBeenCalled();
    expect(component.looking().section.enabled).toBeTrue();
    expect(component.looking().section.position).toBeLessThan(0.5);        // the first cube of the pair, on the low side of X
  });

  it('has switches for only the bad elements and for the cut, and a way to flip the cut', () => {
    const fixture = render();
    const component = fixture.componentInstance;
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.cut')).toBeNull();

    component.toggleOnlyBad();
    component.toggleSection();
    fixture.detectChanges();
    expect(component.looking().onlyBad).toBeTrue();
    expect(root.querySelector('.cut')).not.toBeNull();

    component.setSectionSide('below');
    expect(component.looking().section.keep).toBe('below');
    expect(text(root.querySelector('.cut'))).toContain('лишити менші');
    component.flipSection();
    expect(component.looking().section.keep).toBe('above');
    expect(component.sectionText()).toMatch(/^Y = /);
    component.onSectionPosition({ target: { value: '70' } } as unknown as Event);
    expect(component.looking().section.position).toBeCloseTo(0.7, 6);
  });

  it('has the smoothing on this page, and a slider for how opaque the body is', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('app-smoothing-controls')).not.toBeNull();
    const slider = root.querySelector<HTMLInputElement>('.slider__range')!;
    expect(text(root.querySelector('.slider'))).toContain('70%');          // the one opacity of the body

    slider.value = '40';
    slider.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(text(root.querySelector('.slider'))).toContain('40%');
  });

  it('opens a popup with the maths of a measure from its "i" button, and closes it', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('app-measure-info')).toBeNull();

    root.querySelector<HTMLButtonElement>('.gauge__name')!.click();
    fixture.detectChanges();
    const popup = root.querySelector('app-measure-info')!;
    expect(text(popup)).toContain('Математика');
    expect(text(popup)).toContain('Найкраще');
    expect(text(popup)).toContain('Межа Solvix');
    expect(text(popup)).toContain('Зараз у вашій сітці');

    popup.querySelector<HTMLButtonElement>('.card__close')!.click();
    fixture.detectChanges();
    expect(root.querySelector('app-measure-info')).toBeNull();
  });

  it('knows only accepted or not: two zones per measure and two colours', () => {
    const root = render().nativeElement as HTMLElement;

    expect(root.querySelectorAll('.gauge__zone').length).toBe(2);
    expect(root.querySelector('.legend')).toBeNull();
    expect(root.textContent).not.toMatch(/відмінн|добр|прийнятн|невалідн/i);
  });

  it('puts the overall grade on a row of its own and the single measures under it with their full names', () => {
    const root = render().nativeElement as HTMLElement;
    const grade = root.querySelector<HTMLButtonElement>('.choice__grade')!;
    const measures = Array.from(root.querySelectorAll<HTMLButtonElement>('.choice__measures .choice__btn'));

    expect(text(grade)).toBe('Оцінка');
    expect(measures.map(m => text(m))).toEqual(['Aspect ratio']);

    measures[0].click();
    expect(solver.setQualityMetric).toHaveBeenCalledWith(1, 'aspectRatio');
    grade.click();
    expect(solver.setQualityMetric).toHaveBeenCalledWith(1, 'grade');
  });

  it('has one button for the supports and the loads together', () => {
    const root = render().nativeElement as HTMLElement;
    const button = link(root, 'Закріплення та навантаження');

    expect(text(button)).toContain('показано');          // the loads are on already
    button.click();

    expect(solver.setMarks).toHaveBeenCalledWith(1, 'quality', 'fixed', false);
    expect(solver.setMarks).toHaveBeenCalledWith(1, 'quality', 'loads', false);
  });

  it('asks to click on the scene when nothing is picked, and shows the picked element\'s measures by Solvix', () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    expect(text(root)).not.toContain('Вибраний елемент');

    picked = { hex: 0, ex: 0, ey: 0, ez: 0 };
    fixture.detectChanges();

    expect(text(root.querySelector('.picked__head'))).toContain('Куб 0');
    expect(text(root.querySelector('.detail__head'))).toContain('Solvix');
    expect(text(root.querySelector('.detail__head'))).toContain('Не приймається');
    expect(root.querySelectorAll('.gauge--compact').length).toBe(1);
    const compact = root.querySelector('.gauge--compact')!;
    expect(text(compact)).toContain('Aspect ratio');
    expect(compact.querySelector('.gauge__marker')).not.toBeNull();         // a ruler with a marker, the small one
    expect(text(compact.querySelector('.gauge__ticks'))).toContain('20');   // and the limit on it
  });

  it('clears the pick with the same element picked again', () => {
    const fixture = render();
    picked = { hex: 0, ex: 0, ey: 0, ez: 0 };
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.picked__head .link')!.click();

    expect(solver.setQualityPick).toHaveBeenCalledWith(1, { hex: 0, ex: 0, ey: 0, ez: 0 });
  });

  describe('the look at other tools', () => {
    it('is closed at first and says that it decides nothing', () => {
      const root = render().nativeElement as HTMLElement;
      const part = Array.from(root.querySelectorAll('.part')).find(p => text(p.querySelector('h5')) === 'Інші інструменти')!;

      expect(text(part)).toContain('на розрахунок не впливає');
      expect(part.querySelector('.pill')).toBeNull();
    });

    it('lists the other tools, never Solvix itself, with the share of elements each accepts', () => {
      const fixture = render();
      const root = fixture.nativeElement as HTMLElement;

      link(root, 'Порівняти з іншими інструментами').click();
      fixture.detectChanges();

      expect(Array.from(root.querySelectorAll('.pill')).map(p => text(p))).toEqual(['Abaqus/CAE100%', 'Cubit (Sandia)25%']);
      expect(text(root)).toContain('Лише перегляд');
    });

    it('puts the marks of the chosen tool on the scene, and takes them off again; the verdict stays Solvix\'s', () => {
      const fixture = render();
      const root = fixture.nativeElement as HTMLElement;
      link(root, 'Порівняти з іншими інструментами').click();
      fixture.detectChanges();

      root.querySelectorAll<HTMLButtonElement>('.pill')[1].click();
      fixture.detectChanges();
      expect(solver.setQualityCompare).toHaveBeenCalledWith(1, 'cubit');
      expect(text(root.querySelector('.go--wide'))).toContain('Сітка не приймається');       // Solvix's own, not Cubit's
      expect(text(root.querySelector('.legend'))).toContain('Cubit (Sandia)');

      link(root, 'Закрити').click();
      fixture.detectChanges();
      expect(solver.setQualityCompare).toHaveBeenCalledWith(1, null);
      expect(root.querySelector('.pill')).toBeNull();
    });

    it('keeps the buttons themselves between change-detection passes, so a click is not lost', () => {
      const fixture = render();
      const root = fixture.nativeElement as HTMLElement;
      link(root, 'Порівняти з іншими інструментами').click();
      fixture.detectChanges();
      const before = Array.from(root.querySelectorAll('.pill'));

      fixture.detectChanges();
      fixture.detectChanges();

      expect(Array.from(root.querySelectorAll('.pill')).every((b, i) => b === before[i])).toBeTrue();
    });

    it('shows what the chosen tool says of the picked element', () => {
      compare = 'abaqus';
      picked = { hex: 0, ex: 0, ey: 0, ez: 0 };
      const fixture = render();
      const root = fixture.nativeElement as HTMLElement;

      expect(text(root.querySelector('.detail__head--other'))).toContain('Abaqus/CAE');
      expect(text(root.querySelector('.detail__head--other'))).toContain('Приймається · лише перегляд');
    });
  });
});
