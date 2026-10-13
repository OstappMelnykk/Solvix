import { Component, HostListener, inject } from '@angular/core';
import { UndoRedoService } from '../../state/undo-redo.service';

// The keys that work everywhere in the app, whatever panel is open: Cmd/Ctrl+Z takes back the last action, Cmd/Ctrl+Shift+Z
// (or Ctrl+Y) puts it back. Not while typing in a field, where the field's own undo is wanted. Draws nothing.
@Component({
  selector: 'app-global-shortcuts',
  standalone: true,
  template: ''
})
export class GlobalShortcutsComponent {
  private readonly undoRedo = inject(UndoRedoService);

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable || (target.tagName === 'INPUT' && !GlobalShortcutsComponent.isButtonLike(target as HTMLInputElement)))) return;
    const key = event.key.toLowerCase();
    let done = false;
    if (key === 'z') done = event.shiftKey ? this.undoRedo.redo() : this.undoRedo.undo();
    else if (key === 'y') done = this.undoRedo.redo();
    else return;
    // a key that did something is ours; one with nothing to do is left to the browser
    if (done) event.preventDefault();
  }

  // a checkbox or a slider has no text of its own to undo
  private static isButtonLike(input: HTMLInputElement): boolean {
    return ['checkbox', 'radio', 'range', 'button'].includes(input.type);
  }
}
