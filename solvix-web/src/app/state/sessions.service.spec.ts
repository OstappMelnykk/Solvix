import { TestBed } from '@angular/core/testing';
import { SessionsService } from './sessions.service';

describe('SessionsService', () => {
  let service: SessionsService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(SessionsService);
  });

  it('starts with exactly one session, active', () => {
    expect(service.sessions().length).toBe(1);
    expect(service.activeSessionId()).toBe(service.sessions()[0].id);
  });

  it('createSession adds a new session and makes it active', () => {
    const firstId = service.sessions()[0].id;
    service.createSession();

    expect(service.sessions().length).toBe(2);
    expect(service.sessions()[0].id).toBe(firstId);
    expect(service.activeSessionId()).toBe(service.sessions()[1].id);
  });

  it('closing the only remaining session leaves zero sessions and no active id', () => {
    const onlyId = service.sessions()[0].id;
    service.closeSession(onlyId);

    expect(service.sessions().length).toBe(0);
    expect(service.activeSessionId()).toBeNull();
  });

  it('createSession after closing down to zero works again', () => {
    service.closeSession(service.sessions()[0].id);
    expect(service.sessions().length).toBe(0);

    service.createSession();

    expect(service.sessions().length).toBe(1);
    expect(service.activeSessionId()).toBe(service.sessions()[0].id);
  });

  it('closing a non-active session leaves the active one untouched', () => {
    const first = service.sessions()[0].id;
    service.createSession();
    service.createSession();
    const active = service.activeSessionId();

    service.closeSession(first);

    expect(service.sessions().map(s => s.id)).not.toContain(first);
    expect(service.activeSessionId()).toBe(active);
  });

  it('closing the active middle session activates the one that took its place', () => {
    const first = service.sessions()[0].id;
    service.createSession();
    const middle = service.sessions()[1].id;
    service.createSession();
    const last = service.sessions()[2].id;
    service.selectSession(middle);

    service.closeSession(middle);

    expect(service.sessions().map(s => s.id)).toEqual([first, last]);
    expect(service.activeSessionId()).toBe(last);
  });

  it('closing the active last (rightmost) session activates the new last one', () => {
    const first = service.sessions()[0].id;
    service.createSession();
    const middle = service.sessions()[1].id;
    service.createSession();
    const last = service.sessions()[2].id;

    service.closeSession(last);

    expect(service.sessions().map(s => s.id)).toEqual([first, middle]);
    expect(service.activeSessionId()).toBe(middle);
  });

  it('closing the active first (leftmost) session activates the one that shifted into its place', () => {
    const first = service.sessions()[0].id;
    service.createSession();
    const second = service.sessions()[1].id;
    service.selectSession(first);

    service.closeSession(first);

    expect(service.sessions().map(s => s.id)).toEqual([second]);
    expect(service.activeSessionId()).toBe(second);
  });

  it('closing an unknown session id is a no-op', () => {
    service.createSession();
    const before = service.sessions().map(s => s.id);
    const activeBefore = service.activeSessionId();

    service.closeSession(999999);

    expect(service.sessions().map(s => s.id)).toEqual(before);
    expect(service.activeSessionId()).toBe(activeBefore);
  });
});