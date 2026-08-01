import { Injectable, signal } from '@angular/core';

// Width (%) of the settings panel in the session workspace split. Root-scoped
// and shared by every session on purpose - this is UI chrome, not session
// data, so resizing it in one session must keep it consistent everywhere,
// unlike ActiveWorldService/SharedModelService which are scoped per session.
//
// Percent, not pixel: with unit="pixel", a freshly-mounted <as-split> (a new
// session) computes its pixel layout via an internal signal effect that
// resolves a tick after the component is created, so the canvas briefly
// sizes itself to a wrong/default value before snapping to the correct one -
// visible as the cube jumping size on session switch. Percent avoids this:
// the browser's own CSS grid (`fr` units) resolves the split immediately,
// no JS pixel math against the container's measured width required.
@Injectable({ providedIn: 'root' })
export class RenderSettingsSplitService {
  readonly settingsMinWidth = 20;
  readonly settingsMaxWidth = 40;

  private readonly _settingsWidth = signal(this.settingsMinWidth);

  readonly settingsWidth = this._settingsWidth.asReadonly();

  setSettingsWidth(width: number): void {
    this._settingsWidth.set(width);
  }
}