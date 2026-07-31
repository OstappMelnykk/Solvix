import { Component } from '@angular/core';
import { NgFor } from '@angular/common';

@Component({
  selector: 'app-viewport-toolbar',
  standalone: true,
  imports: [NgFor],
  templateUrl: './viewport-toolbar.component.html',
  styleUrl: './viewport-toolbar.component.scss'
})
export class ViewportToolbarComponent {
  readonly icons = [0, 1, 2, 3, 4];
}