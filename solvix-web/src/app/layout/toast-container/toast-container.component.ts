import { Component, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { NotificationService, ToastKind } from '../../state/notification.service';

const ICON_BY_KIND: Record<ToastKind, string> = {
  error: '✕',
  warning: '⚠',
  success: '✓',
  info: 'ℹ'
};

// Mounted once, app-wide (app.component.html) - the visible half of
// NotificationService's queue. Bottom-left, stacked, self-dismissing -
// see that service's own doc comment for why this exists at all.
@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [NgFor],
  templateUrl: './toast-container.component.html',
  styleUrl: './toast-container.component.scss'
})
export class ToastContainerComponent {
  private readonly notifications = inject(NotificationService);

  readonly toasts = this.notifications.toasts;

  iconFor(kind: ToastKind): string {
    return ICON_BY_KIND[kind];
  }

  dismiss(id: number): void {
    this.notifications.dismiss(id);
  }
}
