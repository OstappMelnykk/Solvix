import { TestBed } from '@angular/core/testing';
import { ActiveWorldService } from './active-world.service';
import { SessionsService } from './sessions.service';

describe('ActiveWorldService', () => {
  let sessions: SessionsService;
  let activeWorld: ActiveWorldService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    sessions = TestBed.inject(SessionsService);
    activeWorld = TestBed.inject(ActiveWorldService);
  });

  it('defaults a session to world index 0', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(activeWorld.activeWorldIndex(sessionId)()).toBe(0);
  });

  it('remembers selectWorld per session', () => {
    const sessionId = sessions.sessions()[0].id;
    activeWorld.selectWorld(sessionId, 2);
    expect(activeWorld.activeWorldIndex(sessionId)()).toBe(2);
  });

  it('drops a session entry once the session is actually closed', () => {
    const sessionId = sessions.sessions()[0].id;
    activeWorld.selectWorld(sessionId, 2);
    expect(activeWorld.activeWorldIndex(sessionId)()).toBe(2);

    sessions.closeSession(sessionId);
    TestBed.flushEffects();

    // Same numeric id, but the entry was pruned - a fresh lookup must
    // recreate it at the default (0), not still read the old value (2).
    expect(activeWorld.activeWorldIndex(sessionId)()).toBe(0);
  });

  it('currentWorldIndex is null when no session is active', () => {
    const sessionId = sessions.sessions()[0].id;
    sessions.closeSession(sessionId);

    expect(activeWorld.currentWorldIndex()).toBeNull();
  });

  it('currentWorldIndex tracks whichever session is active', () => {
    const sessionId = sessions.sessions()[0].id;
    activeWorld.selectWorld(sessionId, 2);

    expect(activeWorld.currentWorldIndex()).toBe(2);
  });

  it('selectCurrentWorld updates the active session and is a no-op with none active', () => {
    const sessionId = sessions.sessions()[0].id;
    activeWorld.selectCurrentWorld(1);
    expect(activeWorld.activeWorldIndex(sessionId)()).toBe(1);

    sessions.closeSession(sessionId);
    expect(() => activeWorld.selectCurrentWorld(2)).not.toThrow();
  });
});