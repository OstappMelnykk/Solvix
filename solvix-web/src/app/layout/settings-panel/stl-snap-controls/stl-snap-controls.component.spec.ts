import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StlSnapControlsComponent } from './stl-snap-controls.component';
import { SurfaceAttachmentService } from '../../../state/surface-attachment.service';

describe('StlSnapControlsComponent', () => {
  let fixture: ComponentFixture<StlSnapControlsComponent>;
  let component: StlSnapControlsComponent;
  let attachments: SurfaceAttachmentService;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    attachments = TestBed.inject(SurfaceAttachmentService);
    fixture = TestBed.createComponent(StlSnapControlsComponent);
    component = fixture.componentInstance;
    component.sessionId = 1;
    fixture.detectChanges();
  });

  it('switches the sticking and sets how close a vertex has to come', () => {
    const [check, number] = Array.from(el().querySelectorAll('input')) as HTMLInputElement[];
    check.checked = false;
    check.dispatchEvent(new Event('change'));
    expect(attachments.snapEnabled()).toBeFalse();

    number.value = '2.5';
    number.dispatchEvent(new Event('change'));
    expect(attachments.snapShare()).toBeCloseTo(0.025, 6);
    expect(component.snapPercent()).toBeCloseTo(2.5, 6);
  });

  it('counts the stuck vertices and lets them all go', () => {
    expect(component.attachedCount()).toBe(0);
    expect((el().querySelector('button.tool') as HTMLButtonElement).disabled).toBeTrue();

    attachments.attach(1, 5);
    fixture.detectChanges();
    expect(component.attachedCount()).toBe(1);
    (el().querySelector('button.tool') as HTMLButtonElement).click();
    expect(component.attachedCount()).toBe(0);
  });

  it('says how to make a vertex let go', () => {
    expect(el().querySelector('.hint')?.textContent).toContain('Alt');
    expect(el().querySelector('.hint')?.textContent).toContain('Відлипити від STL');
  });
});
