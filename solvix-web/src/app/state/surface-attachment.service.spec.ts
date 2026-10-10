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
});
