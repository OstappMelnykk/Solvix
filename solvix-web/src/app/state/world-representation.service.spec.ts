import { TestBed } from '@angular/core/testing';
import { WorldRepresentationService, WorldData } from './world-representation.service';
import { SessionsService } from './sessions.service';

describe('WorldRepresentationService', () => {
  let sessions: SessionsService;
  let representations: WorldRepresentationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    sessions = TestBed.inject(SessionsService);
    representations = TestBed.inject(WorldRepresentationService);
  });

  it('starts a (session, world) pair with no data', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(representations.getRepresentation(sessionId, 0).data).toBeNull();
  });

  it('remembers notifyModification data per (session, world)', () => {
    const sessionId = sessions.sessions()[0].id;
    const data: WorldData = {};
    representations.notifyModification(sessionId, 1, data);

    expect(representations.getRepresentation(sessionId, 1).data).toBe(data);
    expect(representations.getRepresentation(sessionId, 0).data).toBeNull();
  });

  it('clears a session\'s stored data once the session is actually closed', () => {
    const sessionId = sessions.sessions()[0].id;
    representations.notifyModification(sessionId, 2, {});
    expect(representations.getRepresentation(sessionId, 2).data).not.toBeNull();

    sessions.closeSession(sessionId);
    TestBed.flushEffects();

    // Same numeric id, but the underlying store was pruned - a fresh lookup
    // must recreate an empty entry, not still read the old stored data.
    expect(representations.getRepresentation(sessionId, 2).data).toBeNull();
  });

  it('does not clear data belonging to a session that stays open', () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;

    representations.notifyModification(first, 0, {});
    representations.notifyModification(second, 0, {});

    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(representations.getRepresentation(second, 0).data).not.toBeNull();
  });
});