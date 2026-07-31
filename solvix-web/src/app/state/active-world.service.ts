import { Injectable, signal } from '@angular/core';

// Scoped per-session - see SessionComponent's `providers`. Not providedIn
// root: an ActiveWorldService with no session above it should not exist.
@Injectable()
export class ActiveWorldService {
  private readonly _activeWorldIndex = signal(0);

  readonly activeWorldIndex = this._activeWorldIndex.asReadonly();

  selectWorld(index: number): void {
    this._activeWorldIndex.set(index);
  }
}