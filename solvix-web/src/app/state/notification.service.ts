import { Injectable, signal } from '@angular/core';

export type ToastKind = 'error' | 'warning' | 'info' | 'success';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

// How long a toast stays up before auto-dismissing itself. Errors get much
// longer (explicit user request) - a rule violation is worth actually
// reading, not glancing at before it vanishes; warning/info stay short so
// they don't pile up.
const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  error: 25000,
  warning: 5000,
  info: 5000,
  success: 5000
};

// App-wide toast queue (ToastContainerComponent, mounted once at
// app.component.html) - the explicit, hard-to-miss way to surface a rule
// violation (a rejected click, an empty commit, ...) instead of only the
// easy-to-miss inline text some tools already show in their own sidebar.
// Deliberately NOT tied to any one tool/component - any part of the app
// can call error()/warning()/info() without needing its own bespoke
// notice UI (see WorldCanvasComponent's own older .voxel-rule-notice for
// the kind of one-off overlay this is meant to replace going forward).
@Injectable({ providedIn: 'root' })
export class NotificationService {
  readonly toasts = signal<readonly Toast[]>([]);
  private nextId = 0;

  error(message: string): void {
    this.show('error', message);
  }

  success(message: string): void {
    this.show('success', message);
  }

  warning(message: string): void {
    this.show('warning', message);
  }

  info(message: string): void {
    this.show('info', message);
  }

  dismiss(id: number): void {
    this.toasts.update(list => list.filter(toast => toast.id !== id));
  }

  private show(kind: ToastKind, message: string): void {
    const id = this.nextId++;
    this.toasts.update(list => [...list, { id, kind, message }]);
    setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS[kind]);
  }
}
