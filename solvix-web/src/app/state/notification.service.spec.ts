import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(NotificationService);
  });

  it('starts with an empty queue', () => {
    expect(service.toasts()).toEqual([]);
  });

  it('error()/warning()/info()/success() each push a toast of their own kind', () => {
    service.error('boom');
    service.warning('careful');
    service.info('fyi');
    service.success('done');
    const kinds = service.toasts().map(toast => toast.kind);
    const messages = service.toasts().map(toast => toast.message);
    expect(kinds).toEqual(['error', 'warning', 'info', 'success']);
    expect(messages).toEqual(['boom', 'careful', 'fyi', 'done']);
  });

  it('assigns each toast a distinct, increasing id', () => {
    service.info('first');
    service.info('second');
    const ids = service.toasts().map(toast => toast.id);
    expect(ids[1]).toBeGreaterThan(ids[0]);
  });

  it('dismiss() removes only the matching toast', () => {
    service.info('keep me');
    service.info('drop me');
    const dropId = service.toasts()[1].id;
    service.dismiss(dropId);
    expect(service.toasts().length).toBe(1);
    expect(service.toasts()[0].message).toBe('keep me');
  });

  it('dismiss() on an unknown id is a no-op', () => {
    service.info('stays');
    service.dismiss(9999);
    expect(service.toasts().length).toBe(1);
  });

  it('auto-dismisses a warning/info/success toast after 5 seconds, not before', fakeAsync(() => {
    service.warning('careful');
    tick(4999);
    expect(service.toasts().length).toBe(1);
    tick(1);
    expect(service.toasts().length).toBe(0);
  }));

  it('auto-dismisses an error toast after 25 seconds, not before', fakeAsync(() => {
    service.error('boom');
    tick(24999);
    expect(service.toasts().length).toBe(1);
    tick(1);
    expect(service.toasts().length).toBe(0);
  }));

  it('an error toast outlives a warning toast raised at the same time', fakeAsync(() => {
    service.error('boom');
    service.warning('careful');
    tick(5000);
    // Warning is gone, error (25s) is still up.
    expect(service.toasts().length).toBe(1);
    expect(service.toasts()[0].kind).toBe('error');
    tick(20000);
    expect(service.toasts().length).toBe(0);
  }));
});
