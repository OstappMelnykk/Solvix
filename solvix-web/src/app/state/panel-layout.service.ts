import { Injectable, signal } from '@angular/core';

// Panel widths for the session workspace split (render window vs settings
// panel). Root-scoped and shared by every session on purpose - this is UI
// chrome, not session data, so resizing it in one session must keep it
// consistent everywhere, unlike ActiveWorldService/SharedModelService which
// are scoped per session.
@Injectable({ providedIn: 'root' })
export class PanelLayoutService {
  readonly settingsMinWidth = Math.round(window.screen.width * 0.2);
  readonly settingsMaxWidth = Math.round(window.screen.width * 0.4);

  private readonly _renderWindowWidth = signal(Math.round(window.screen.width * 0.8));
  private readonly _settingsWidth = signal(this.settingsMinWidth);

  readonly renderWindowWidth = this._renderWindowWidth.asReadonly();
  readonly settingsWidth = this._settingsWidth.asReadonly();

  setSizes(renderWindowWidth: number, settingsWidth: number): void {
    this._renderWindowWidth.set(renderWindowWidth);
    this._settingsWidth.set(settingsWidth);
  }
}