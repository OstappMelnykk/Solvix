import { TestBed } from '@angular/core/testing';
import { MeasureInfoComponent } from './measure-info.component';
import { SolverQualityLimitDto } from '../../../../api/solver-api.service';

describe('MeasureInfoComponent', () => {
  const limit: SolverQualityLimitDto = {
    key: 'jacobianRatio', label: 'Рівномірність якобіана', short: 'Якобіан', tech: 'Jacobian ratio', hint: '', higherIsBetter: false,
    levels: 2, bounds: [30], unit: '', decimals: 1, kind: 'plain', errorBound: 1000
  };

  it('draws the formulas with KaTeX, and the KaTeX stylesheet is in effect (otherwise the maths is garbled)', () => {
    const fixture = TestBed.createComponent(MeasureInfoComponent);
    fixture.componentRef.setInput('limit', limit);
    fixture.componentRef.setInput('tool', 'solvix');
    fixture.componentRef.setInput('shown', '8.6');
    fixture.componentRef.setInput('ok', true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);

    const formulas = root.querySelectorAll('.formula .katex');
    expect(formulas.length).toBe(4);
    expect(getComputedStyle(formulas[0]).fontFamily).toContain('KaTeX_Main');
    expect(root.querySelector('.katex-mathml')).toBeNull();      // only the HTML rendering, no duplicated text
    root.remove();
  });
});
