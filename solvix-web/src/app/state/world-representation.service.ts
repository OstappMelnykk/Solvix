import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';
import { SharedModelService } from './shared-model.service';

// Each World represents the shared model in its own way, and each
// representation's own state is kept somewhere per world. How a world
// derives its representation from the model, and what that state
// actually contains, is intentionally undefined - this is the seam where
// backend-driven per-world logic plugs in later.
//
// Scoped per-session - see SessionComponent's `providers`. It resolves
// SharedModelService from that same session scope, so it always sees its
// own session's model, never another session's.
@Injectable()
export class WorldRepresentationService {
  private readonly shared = inject(SharedModelService);

  // Placeholder: every world currently gets the same, unmodified model.
  getRepresentation(worldIndex: number): THREE.BufferGeometry {
    void worldIndex;
    return this.shared.getModel();
  }

  // Placeholder: seam for recording/mapping a world's modification.
  notifyModification(worldIndex: number): void {
    void worldIndex;
  }
}