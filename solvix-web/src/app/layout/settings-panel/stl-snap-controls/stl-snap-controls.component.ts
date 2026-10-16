import { Component, Input, inject } from '@angular/core';
import { SurfaceAttachmentService } from '../../../state/surface-attachment.service';

// The sticking of the vertices to the imported STL: on or off, how close a dragged vertex has to come, how many are stuck, and letting them all go.
// Part of the block of the settings of the STL (Real World, where the vertices are moved).
@Component({
  selector: 'app-stl-snap-controls',
  standalone: true,
  templateUrl: './stl-snap-controls.component.html',
  styleUrl: './stl-snap-controls.component.scss'
})
export class StlSnapControlsComponent {
  private readonly attachments = inject(SurfaceAttachmentService);

  @Input({ required: true }) sessionId!: number | null;

  snapEnabled(): boolean {
    return this.attachments.snapEnabled();
  }

  onSnapEnabled(event: Event): void {
    this.attachments.setSnapEnabled((event.target as HTMLInputElement).checked);
  }

  // The sensitivity: how close to the STL (in % of its size) a dragged vertex sticks.
  snapPercent(): number {
    return Math.round(this.attachments.snapShare() * 1000) / 10;
  }

  onSnapPercent(event: Event): void {
    this.attachments.setSnapShare(Number((event.target as HTMLInputElement).value) / 100);
  }

  attachedCount(): number {
    return this.sessionId === null ? 0 : this.attachments.count(this.sessionId);
  }

  detachAllNodes(): void {
    if (this.sessionId !== null) this.attachments.detachAll(this.sessionId);
  }
}
