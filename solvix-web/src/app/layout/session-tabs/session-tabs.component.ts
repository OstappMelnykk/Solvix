import { Component, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { SessionsService } from '../../state/sessions.service';

@Component({
  selector: 'app-session-tabs',
  standalone: true,
  imports: [NgFor],
  templateUrl: './session-tabs.component.html',
  styleUrl: './session-tabs.component.scss'
})
export class SessionTabsComponent {
  readonly sessions = inject(SessionsService);
}