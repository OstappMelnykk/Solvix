import { Component, EventEmitter, HostListener, Input, Output, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import katex from 'katex';
import { NgFor, NgIf } from '@angular/common';
import { SolverQualityLimitDto } from '../../../../api/solver-api.service';
import { MeasureExplain, explainFor } from '../../../../geometry/quality-explain';
import { ruleText } from '../../../../geometry/quality-grading';

// The popup of a measure's "i" button: what it is, the maths, what it changes, the best and the extreme values, the
// limit, and where the mesh stands now.
@Component({
  selector: 'app-measure-info',
  standalone: true,
  imports: [NgIf, NgFor],
  templateUrl: './measure-info.component.html',
  styleUrl: './measure-info.component.scss'
})
export class MeasureInfoComponent {
  @Input({ required: true }) limit!: SolverQualityLimitDto;
  @Input({ required: true }) tool!: string;
  @Input({ required: true }) shown!: string;
  @Input({ required: true }) ok!: boolean;
  private readonly sanitizer = inject(DomSanitizer);

  @Output() closed = new EventEmitter<void>();

  get explain(): MeasureExplain | null {
    return explainFor(this.tool, this.limit.key);
  }

  // One formula drawn by KaTeX. The text is ours (a fixed table), never the user's, so its markup is trusted - the
  // sanitizer would strip the inline sizes KaTeX relies on.
  tex(line: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(katex.renderToString(line, { displayMode: true, throwOnError: false, output: 'html' }));
  }

  get rule(): string {
    return ruleText(this.limit);
  }

  get error(): string {
    const e = this.limit.errorBound;
    return e === null ? '' : `${e >= 1e6 ? '10⁶' : e}${this.limit.unit}`;
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.closed.emit();
  }
}
