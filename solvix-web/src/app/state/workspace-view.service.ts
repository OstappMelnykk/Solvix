import { Injectable, signal } from '@angular/core';

// Which toolbar icon is selected - drives what AppComponent shows in the
// main body area (the render-window/settings-panel split for tool 0, some
// other view per tool otherwise). Root-scoped and app-wide, like
// RenderSettingsSplitService: this is UI chrome, not session data, so it's
// shared across every session rather than keyed by sessionId.
@Injectable({ providedIn: 'root' })
export class WorkspaceViewService {
  private readonly _activeView = signal(0);
  readonly activeView = this._activeView.asReadonly();

  selectView(index: number): void {
    this._activeView.set(index);
  }
}