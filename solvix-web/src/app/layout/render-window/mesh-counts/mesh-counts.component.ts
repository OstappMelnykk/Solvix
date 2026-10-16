import { Component, Input, inject } from '@angular/core';
import { NgIf } from '@angular/common';
import { MeshEditorService } from '../../../state/mesh-editor.service';
import { SolverService } from '../../../state/solver.service';

// How big the body is, shown on every canvas: the cubes it was built from (the parent elements) and the finite elements the solver works on (the leaves: the cubes
// cut evenly, or the leaves of the local refinement).
@Component({
  selector: 'app-mesh-counts',
  standalone: true,
  imports: [NgIf],
  template: `<div class="counts" *ngIf="parents() > 0">
    <span title="Куби, з яких збудовано тіло">Початкових: <b>{{ parents() }}</b></span>
    <span title="Скінченні елементи, на яких рахує солвер: листки сітки">Листкових (скінченних): <b>{{ leaves() ?? '…' }}</b></span>
  </div>`,
  styles: [`
    :host { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); pointer-events: none; z-index: 2; }
    .counts { display: flex; gap: 14px; padding: 3px 10px; border-radius: 6px; background: rgba(30, 31, 34, 0.78); color: #c8ccd2; font-size: 12px; white-space: nowrap; }
    b { color: #fff; font-weight: 600; }
  `]
})
export class MeshCountsComponent {
  private readonly editor = inject(MeshEditorService);
  private readonly solver = inject(SolverService);

  @Input({ required: true }) sessionId!: number;

  // The cubes the body is made of.
  parents(): number {
    return this.editor.getState(this.sessionId)?.hexes.length ?? 0;
  }

  // The finite elements: those of the refined mesh once it has arrived, else every cube cut into its division.
  leaves(): number | null {
    if (this.solver.isLocal(this.sessionId)) return this.solver.mesh(this.sessionId)?.elementCount ?? null;
    const [nx, ny, nz] = this.solver.divisions(this.sessionId);
    return this.parents() * nx * ny * nz;
  }
}
