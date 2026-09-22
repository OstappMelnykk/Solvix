import { Component, inject, signal } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { SessionsService } from '../../state/sessions.service';
import { clearAllSolvixStorage } from '../../state/local-storage-json';

@Component({
  selector: 'app-session-tabs',
  standalone: true,
  imports: [NgFor, NgIf],
  templateUrl: './session-tabs.component.html',
  styleUrl: './session-tabs.component.scss'
})
export class SessionTabsComponent {
  readonly sessions = inject(SessionsService);

  closeSession(event: MouseEvent, id: number): void {
    event.stopPropagation();
    this.sessions.closeSession(id);
  }

  // Inline "Точно?" prompt, not window.confirm() - see ZoneListComponent's
  // own pendingConfirmation comment for why (a native dialog can end up
  // silently auto-suppressed by the browser after a few confirm()/alert()
  // calls, which reads as "nothing happened" from the outside - an in-app
  // prompt can't be silently swallowed like that).
  readonly isResetConfirming = signal(false);

  requestReset(): void {
    this.isResetConfirming.set(true);
  }

  cancelReset(): void {
    this.isResetConfirming.set(false);
  }

  // Wipes every session/model/import/voxelization/zone ever persisted
  // (every session, not just the active one) and reloads the page - see
  // clearAllSolvixStorage's own comment for why a reload, not a manual
  // in-memory reset, is what actually gets back to a genuinely clean sheet.
  confirmReset(): void {
    clearAllSolvixStorage();
    this.reloadPage();
  }

  // Its own method, not window.location.reload() called directly from
  // confirmReset() above - Location.prototype.reload isn't configurable in
  // a real browser (Karma runs this suite in actual Chrome, not jsdom), so
  // spyOn(window.location, 'reload') can't intercept it; spying on this
  // component's own method instead lets tests verify a reload was
  // requested without one actually tearing down the test runner page.
  protected reloadPage(): void {
    window.location.reload();
  }
}