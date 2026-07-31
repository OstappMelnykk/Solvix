import { Component, inject } from '@angular/core';
import { NgFor } from '@angular/common';
import { WORLDS_CONFIG } from '../../../config/worlds.config';
import { ActiveWorldService } from '../../../state/active-world.service';

@Component({
  selector: 'app-world-tabs',
  standalone: true,
  imports: [NgFor],
  templateUrl: './world-tabs.component.html',
  styleUrl: './world-tabs.component.scss'
})
export class WorldTabsComponent {
  readonly state = inject(ActiveWorldService);
  readonly worlds = WORLDS_CONFIG;
}