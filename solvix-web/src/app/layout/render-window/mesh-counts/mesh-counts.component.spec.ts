import { TestBed } from '@angular/core/testing';
import { MeshCountsComponent } from './mesh-counts.component';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { SolverService } from '../../../state/solver.service';
import { linkedPairState } from '../../../geometry/mesh-state.fixture.spec';

describe('MeshCountsComponent', () => {
  let local: boolean;
  let mesh: { elementCount: number } | null;
  let divisions: number[];

  const render = (): HTMLElement => {
    const fixture = TestBed.createComponent(MeshCountsComponent);
    fixture.componentInstance.sessionId = 1;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => {
    local = false;
    mesh = null;
    divisions = [2, 2, 1];
    TestBed.configureTestingModule({
      providers: [
        { provide: MeshEditorService, useValue: { getState: () => linkedPairState() } },
        { provide: SolverService, useValue: { isLocal: () => local, mesh: () => mesh, divisions: () => divisions } }
      ]
    });
  });

  it('counts the cubes, and the elements of the even division as cubes times parts', () => {
    const text = render().textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('Початкових: 2');
    expect(text).toContain('Листкових (скінченних): 8');
  });

  it('counts the elements of the refined mesh once it has arrived, and shows a dots before', () => {
    local = true;
    expect(render().textContent).toContain('…');
    mesh = { elementCount: 57 };
    expect(render().textContent!.replace(/\s+/g, ' ')).toContain('Листкових (скінченних): 57');
  });
});
