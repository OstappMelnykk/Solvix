import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionTabsComponent } from './session-tabs.component';
import { SessionsService } from '../../state/sessions.service';

describe('SessionTabsComponent', () => {
  let fixture: ComponentFixture<SessionTabsComponent>;
  let component: SessionTabsComponent;
  let sessions: SessionsService;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SessionTabsComponent] });
    fixture = TestBed.createComponent(SessionTabsComponent);
    component = fixture.componentInstance;
    sessions = TestBed.inject(SessionsService);
    fixture.detectChanges();
  });

  it('starts with the reset prompt not showing', () => {
    expect(component.isResetConfirming()).toBeFalse();
  });

  it('requestReset shows the inline confirmation instead of clearing anything', () => {
    localStorage.setItem('solvix:model:1', '{}');

    component.requestReset();

    expect(component.isResetConfirming()).toBeTrue();
    expect(localStorage.getItem('solvix:model:1')).toBe('{}');
  });

  it('cancelReset hides the prompt without touching storage', () => {
    component.requestReset();
    component.cancelReset();

    expect(component.isResetConfirming()).toBeFalse();
    expect(sessions.sessions().length).toBe(1);
  });

  it('confirmReset wipes every solvix: key and requests a page reload', () => {
    localStorage.setItem('solvix:model:1', '{}');
    localStorage.setItem('solvix:zone-painting:1', '{}');
    localStorage.setItem('unrelated-key', 'kept');
    const reloadSpy = spyOn<any>(component, 'reloadPage');

    component.confirmReset();

    expect(localStorage.getItem('solvix:sessions')).toBeNull();
    expect(localStorage.getItem('solvix:model:1')).toBeNull();
    expect(localStorage.getItem('solvix:zone-painting:1')).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('kept');
    expect(reloadSpy).toHaveBeenCalled();
  });
});
