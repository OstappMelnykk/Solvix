import { Injectable, signal } from '@angular/core';

// Whether the popup with the refinement templates (the "Переглянути шаблони" button beside the local refinement) is open.
@Injectable({ providedIn: 'root' })
export class RefinementTemplatesService {
  readonly isOpen = signal(false);

  open(): void {
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }
}
