import { Component, Input, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import { MeshEditorService } from '../../../state/mesh-editor.service';

// The smoothing of the mesh, with every setting the user's: passes, step, how strongly the local density is kept, and
// whether (and how far) the outer surface slides too. It lives on the Quality page, where its effect is seen.
@Component({
  selector: 'app-smoothing-controls',
  standalone: true,
  imports: [NgIf],
  templateUrl: './smoothing-controls.component.html',
  styleUrl: './smoothing-controls.component.scss'
})
export class SmoothingControlsComponent {
  private readonly editor = inject(MeshEditorService);

  @Input({ required: true }) sessionId!: number;

  iterations = 10;
  relaxation = 0.5;
  densityPercent = 100;
  featureAngle = 25;
  // Also slide the vertices on the outer surface (along it); off by default, since it moves them off the STL.
  surface = false;

  get busy(): boolean {
    return this.editor.busy();
  }

  // Two cubes make no interior vertex, but the surface can still be smoothed, so one cube is the only thing that is not enough.
  hexCount(): number {
    return this.editor.getState(this.sessionId)?.hexes.length ?? 0;
  }

  onNumber(field: 'iterations' | 'relaxation' | 'density' | 'angle', event: Event): void {
    const input = event.target as HTMLInputElement;
    const raw = Number(input.value);
    const limits = { iterations: [1, 200, 10], relaxation: [0.05, 1, 0.5], density: [0, 100, 100], angle: [1, 90, 25] }[field];
    let value = Number.isFinite(raw) ? Math.min(limits[1], Math.max(limits[0], raw)) : limits[2];
    if (field === 'iterations') value = Math.round(value);
    if (field === 'iterations') this.iterations = value;
    else if (field === 'relaxation') this.relaxation = value;
    else if (field === 'density') this.densityPercent = value;
    else this.featureAngle = value;
    input.value = String(value);
  }

  onSurface(event: Event): void {
    this.surface = (event.target as HTMLInputElement).checked;
  }

  smooth(): void {
    if (this.busy || this.hexCount() < 2) return;
    this.editor.smooth(this.sessionId, {
      iterations: this.iterations,
      relaxation: this.relaxation,
      surface: this.surface,
      density: this.densityPercent / 100,
      featureAngle: this.featureAngle
    });
  }
}
