import { TestBed } from '@angular/core/testing';
import { SurfaceAttachmentService } from './surface-attachment.service';

describe('SurfaceAttachmentService', () => {
  let attachments: SurfaceAttachmentService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    attachments = TestBed.inject(SurfaceAttachmentService);
  });

  it('keeps the stuck nodes per session and changes its revision only when the set changes', () => {
    expect(attachments.count(1)).toBe(0);
    const start = attachments.revision(1);

    attachments.attach(1, 7);
    attachments.attach(1, 7);                         // already stuck
    expect(attachments.isAttached(1, 7)).toBeTrue();
    expect(attachments.isAttached(2, 7)).toBeFalse();
    expect(attachments.revision(1)).toBe(start + 1);

    attachments.detach(1, 9);                         // never was
    expect(attachments.revision(1)).toBe(start + 1);
    attachments.detach(1, 7);
    expect(attachments.count(1)).toBe(0);
    expect(attachments.revision(1)).toBe(start + 2);
  });

  it('detaches all at once', () => {
    attachments.attach(1, 1);
    attachments.attach(1, 2);
    const before = attachments.revision(1);

    attachments.detachAll(1);
    attachments.detachAll(1);

    expect(attachments.count(1)).toBe(0);
    expect(attachments.revision(1)).toBe(before + 1);
  });

  it('forgets the nodes that are gone from the mesh', () => {
    [1, 2, 3].forEach(n => attachments.attach(1, n));

    attachments.retain(1, id => id !== 2);

    expect([...attachments.attached(1)]).toEqual([1, 3]);
  });

  it('sticks within 1% of the surface\'s size by default, and keeps the user\'s sensitivity within 0.1%..5%', () => {
    expect(attachments.snapShare()).toBe(0.01);

    attachments.setSnapShare(0.02);
    expect(attachments.snapShare()).toBe(0.02);
    attachments.setSnapShare(0.5);
    expect(attachments.snapShare()).toBe(0.05);
    attachments.setSnapShare(0);
    expect(attachments.snapShare()).toBe(0.001);
    attachments.setSnapShare(NaN);
    expect(attachments.snapShare()).toBe(0.001);
  });

  it('can be switched off, and is on by default', () => {
    expect(attachments.snapEnabled()).toBeTrue();

    attachments.setSnapEnabled(false);

    expect(attachments.snapEnabled()).toBeFalse();
  });

  it('has a "place on the surface" mode, off to begin with', () => {
    expect(attachments.placeMode()).toBeFalse();

    attachments.setPlaceMode(true);

    expect(attachments.placeMode()).toBeTrue();
  });
});
