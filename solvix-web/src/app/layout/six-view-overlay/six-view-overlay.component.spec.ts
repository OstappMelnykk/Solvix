import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import * as THREE from 'three';
import { SixViewOverlayComponent } from './six-view-overlay.component';
import { SixViewOverlayService, SixViewSource } from '../../state/six-view-overlay.service';
import { MeshEditorSelectionService } from '../../state/mesh-editor-selection.service';
import { SurfaceSnapper } from '../../geometry/surface-snap';

describe('SixViewOverlayComponent (main panel)', () => {
  let overlay: SixViewOverlayService;
  let component: SixViewOverlayComponent;

  const source = (nodesEditable: boolean | undefined): SixViewSource => ({
    scene: new THREE.Scene(),
    sessionId: 1,
    isIdealWorld: false,
    framingObjects: [],
    hiddenDuringView: [],
    meshView: () => null,
    nodesEditable
  });

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    overlay = TestBed.inject(SixViewOverlayService);
    component = TestBed.runInInjectionContext(() => new SixViewOverlayComponent());
  });

  it('starts as the plain grid with no main panel', () => {
    expect(component.mainPanel).toBeNull();
    expect(component.isMain(0)).toBeFalse();
    expect(component.dragText).toBeNull();
  });

  it('makes a panel the large one, and the same call again goes back to the grid', () => {
    component.toggleMain(3);
    expect(component.mainPanel).toBe(3);
    expect(component.isMain(3)).toBeTrue();
    expect(component.isMain(2)).toBeFalse();

    component.toggleMain(3);
    expect(component.mainPanel).toBeNull();
  });

  it('switching to another panel replaces the main one', () => {
    component.toggleMain(1);
    component.toggleMain(4);

    expect(component.mainPanel).toBe(4);
  });

  it('nodes can be dragged in any panel of a World where they are editable, with no view enlarged first', () => {
    overlay.open(source(true));
    expect(component.mainPanel).toBeNull();
    expect(component.canDragNodes()).toBeTrue();

    component.toggleMain(2);
    expect(component.canDragNodes()).toBeTrue();

    overlay.open(source(false));                      // e.g. the Ideal World's overlay
    expect(component.canDragNodes()).toBeFalse();
    overlay.open(source(undefined));
    expect(component.canDragNodes()).toBeFalse();
    overlay.close();
    expect(component.canDragNodes()).toBeFalse();
  });

  it('leaving the main panel clears any half-finished drag text', () => {
    component.toggleMain(0);
    component.dragText = 'X 1.000  Y 2.000  Z 3.000';

    component.toggleMain(0);

    expect(component.dragText).toBeNull();
  });

  describe('header hint', () => {
    it('is empty with nothing open or without a mesh editor', () => {
      expect(component.headerHint()).toBe('');
      overlay.open({ ...source(true), meshView: undefined });
      expect(component.headerHint()).toBe('');
    });

    it('tells the user in the Ideal World that nodes do not move there and where they do', () => {
      overlay.open(source(false));

      expect(component.headerHint()).toContain('Ideal World');
      expect(component.headerHint()).toContain('Real World');
    });

    it('in the Real World explains the gizmo, needs no enlarged view and no Shift', () => {
      overlay.open(source(true));

      expect(component.headerHint()).toContain('Стрілка тягне по осі');
      expect(component.headerHint()).toContain('центр');
      expect(component.headerHint()).toContain('будь-якому виді');
      expect(component.headerHint()).not.toContain('Shift');
      expect(component.headerHint()).not.toContain('⤢');
    });
  });

  describe('letting go of a node stuck to the imported surface', () => {
    let attached: Set<number>;
    const withSurface = (): SixViewSource => ({
      ...source(true),
      surface: {
        snapper: () => new SurfaceSnapper(new THREE.Group()),
        isAttached: id => attached.has(id),
        setAttached: (id, on) => (on ? attached.add(id) : attached.delete(id)),
        share: () => 0.01,
        enabled: () => true
      }
    });

    beforeEach(() => {
      attached = new Set<number>([5]);
      overlay.open(withSurface());
    });

    it('offers it only for the selected node, and only when it is stuck', () => {
      const selection = TestBed.inject(MeshEditorSelectionService);
      expect(component.canDetach()).toBeFalse();            // nothing selected

      selection.selectNode(1, 6);
      expect(component.canDetach()).toBeFalse();            // a free node

      selection.selectNode(1, 6);                           // unselect
      selection.selectNode(1, 5);
      expect(component.canDetach()).toBeTrue();
    });

    it('lets the node go', () => {
      TestBed.inject(MeshEditorSelectionService).selectNode(1, 5);

      component.detach();

      expect(attached.has(5)).toBeFalse();
      expect(component.canDetach()).toBeFalse();
    });

    it('has nothing to let go of where there is no surface (the Ideal World)', () => {
      overlay.open(source(false));
      TestBed.inject(MeshEditorSelectionService).selectNode(1, 5);

      expect(component.canDetach()).toBeFalse();
      expect(() => component.detach()).not.toThrow();
    });
  });
});
