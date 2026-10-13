import { TestBed } from '@angular/core/testing';
import { UndoRedoService } from '../../state/undo-redo.service';
import { GlobalShortcutsComponent } from './global-shortcuts.component';

describe('GlobalShortcutsComponent', () => {
  let component: GlobalShortcutsComponent;
  let undoRedo: jasmine.SpyObj<UndoRedoService>;

  beforeEach(() => {
    undoRedo = jasmine.createSpyObj<UndoRedoService>('UndoRedoService', ['undo', 'redo']);
    undoRedo.undo.and.returnValue(true);
    undoRedo.redo.and.returnValue(true);
    TestBed.configureTestingModule({ providers: [{ provide: UndoRedoService, useValue: undoRedo }] });
    component = TestBed.runInInjectionContext(() => new GlobalShortcutsComponent());
  });

  const press = (key: string, init: KeyboardEventInit = {}, target?: Element) => {
    const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
    if (target) Object.defineProperty(event, 'target', { value: target });
    component.onKeyDown(event);
    return event;
  };

  it('Cmd+Z and Ctrl+Z undo; Cmd/Ctrl+Shift+Z and Ctrl+Y redo', () => {
    expect(press('z', { metaKey: true }).defaultPrevented).toBeTrue();
    press('z', { ctrlKey: true });
    expect(undoRedo.undo).toHaveBeenCalledTimes(2);

    press('z', { metaKey: true, shiftKey: true });
    press('Z', { ctrlKey: true, shiftKey: true });
    press('y', { ctrlKey: true });
    expect(undoRedo.redo).toHaveBeenCalledTimes(3);
  });

  it('leaves the key to the browser when there is nothing to undo, and when no Ctrl/Cmd is held', () => {
    undoRedo.undo.and.returnValue(false);

    expect(press('z', { metaKey: true }).defaultPrevented).toBeFalse();
    press('z');
    press('a', { metaKey: true });

    expect(undoRedo.redo).not.toHaveBeenCalled();
    expect(undoRedo.undo).toHaveBeenCalledTimes(1);
  });

  it('does not take the key while typing in a field (the field has its own undo), but does over a checkbox or a slider', () => {
    const text = document.createElement('input');
    text.type = 'number';
    press('z', { metaKey: true }, text);
    press('z', { metaKey: true }, document.createElement('textarea'));
    expect(undoRedo.undo).not.toHaveBeenCalled();

    const box = document.createElement('input');
    box.type = 'checkbox';
    press('z', { metaKey: true }, box);
    const slider = document.createElement('input');
    slider.type = 'range';
    press('z', { metaKey: true }, slider);
    expect(undoRedo.undo).toHaveBeenCalledTimes(2);
  });
});
