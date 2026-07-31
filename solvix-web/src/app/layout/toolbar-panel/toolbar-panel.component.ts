import { Component } from '@angular/core';
import { NgFor } from '@angular/common';

@Component({
  selector: 'app-toolbar-panel',
  standalone: true,
  imports: [NgFor],
  templateUrl: './toolbar-panel.component.html',
  styleUrl: './toolbar-panel.component.scss'
})
export class ToolbarPanelComponent {
  readonly icons = [0, 1, 2, 3, 4];
}