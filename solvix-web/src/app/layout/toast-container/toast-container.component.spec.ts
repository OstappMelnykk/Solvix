import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ToastContainerComponent } from './toast-container.component';
import { NotificationService } from '../../state/notification.service';

describe('ToastContainerComponent', () => {
  let fixture: ComponentFixture<ToastContainerComponent>;
  let notifications: NotificationService;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ToastContainerComponent] });
    fixture = TestBed.createComponent(ToastContainerComponent);
    notifications = TestBed.inject(NotificationService);
    fixture.detectChanges();
  });

  function toastElements(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.toast'));
  }

  it('renders nothing when the queue is empty', () => {
    expect(toastElements().length).toBe(0);
  });

  it('renders one element per queued toast, with its message', () => {
    notifications.error('щось зламалось');
    notifications.info('готово');
    fixture.detectChanges();

    const elements = toastElements();
    expect(elements.length).toBe(2);
    expect(elements[0].textContent).toContain('щось зламалось');
    expect(elements[1].textContent).toContain('готово');
  });

  it("gives an error toast the toast--error class", () => {
    notifications.error('щось зламалось');
    fixture.detectChanges();
    expect(toastElements()[0].classList.contains('toast--error')).toBe(true);
  });

  it('gives a success toast the toast--success class and a checkmark icon', () => {
    notifications.success('Зону створено: 3 вокселів.');
    fixture.detectChanges();
    const element = toastElements()[0];
    expect(element.classList.contains('toast--success')).toBe(true);
    expect(element.querySelector('.toast__icon')?.textContent).toBe('✓');
  });

  it('clicking the close button dismisses just that toast', () => {
    notifications.error('перший');
    notifications.info('другий');
    fixture.detectChanges();

    const closeButtons: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.toast__close'));
    expect(closeButtons.length).toBe(2);
    closeButtons[0].click();
    fixture.detectChanges();

    const remaining = toastElements();
    expect(remaining.length).toBe(1);
    expect(remaining[0].textContent).toContain('другий');
  });

  it('re-renders automatically when the service queue changes elsewhere', () => {
    expect(toastElements().length).toBe(0);
    notifications.warning('пізніше додано');
    fixture.detectChanges();
    expect(toastElements().length).toBe(1);
  });
});
