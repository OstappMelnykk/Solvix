import { TestBed } from '@angular/core/testing';
import { ImportedReferenceDisplayService } from './imported-reference-display.service';
import { SessionsService } from './sessions.service';

describe('ImportedReferenceDisplayService', () => {
  let sessions: SessionsService;
  let display: ImportedReferenceDisplayService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    sessions = TestBed.inject(SessionsService);
    display = TestBed.inject(ImportedReferenceDisplayService);
  });

  it('returns sensible defaults for a session that has never set a style', () => {
    const sessionId = sessions.sessions()[0].id;

    const style = display.getStyle(sessionId);

    expect(style.visible).toBe(true);
    expect(style.mode).toBe('solid');
    expect(style.color).toBe(0xffffff);
    expect(style.opacity).toBe(0.5);
    expect(style.dimensionsVisible).toBe(true);
    expect(style.rulerVisible).toBe(true);
    expect(style.rulerDistance).toBe(1);
    expect(style.rotateGizmoVisible).toBe(true);
  });

  it('setters patch only the field they touch, leaving the rest at whatever they were', () => {
    const sessionId = sessions.sessions()[0].id;

    display.setVisible(sessionId, false);
    display.setColor(sessionId, 0x112233);

    const style = display.getStyle(sessionId);
    expect(style.visible).toBe(false);
    expect(style.color).toBe(0x112233);
    expect(style.mode).toBe('solid'); // untouched
  });

  it('setMode switches between solid and wireframe', () => {
    const sessionId = sessions.sessions()[0].id;

    display.setMode(sessionId, 'wireframe');

    expect(display.getStyle(sessionId).mode).toBe('wireframe');
  });

  it('setOpacity clamps to [0, 1]', () => {
    const sessionId = sessions.sessions()[0].id;

    display.setOpacity(sessionId, 1.5);
    expect(display.getStyle(sessionId).opacity).toBe(1);

    display.setOpacity(sessionId, -0.5);
    expect(display.getStyle(sessionId).opacity).toBe(0);
  });

  it('setRulerDistance clamps to non-negative', () => {
    const sessionId = sessions.sessions()[0].id;

    display.setRulerDistance(sessionId, -3);

    expect(display.getStyle(sessionId).rulerDistance).toBe(0);
  });

  it('setDimensionsVisible/setRulerVisible/setRotateGizmoVisible are independent toggles', () => {
    const sessionId = sessions.sessions()[0].id;

    display.setDimensionsVisible(sessionId, false);
    display.setRulerVisible(sessionId, false);
    display.setRotateGizmoVisible(sessionId, false);

    const style = display.getStyle(sessionId);
    expect(style.dimensionsVisible).toBe(false);
    expect(style.rulerVisible).toBe(false);
    expect(style.rotateGizmoVisible).toBe(false);
    expect(style.visible).toBe(true); // still untouched
  });

  it('isolates styles per session', () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;

    display.setColor(first, 0xff0000);

    expect(display.getStyle(first).color).toBe(0xff0000);
    expect(display.getStyle(second).color).toBe(0xffffff);
  });

  it('drops a closed session\'s style and leaves other sessions untouched', () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;
    display.setColor(first, 0xff0000);
    display.setColor(second, 0x00ff00);

    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(display.getStyle(first).color).toBe(0xffffff); // back to default, entry pruned
    expect(display.getStyle(second).color).toBe(0x00ff00);
  });
});