import { Component, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { SessionsService } from '../../state/sessions.service';

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
}