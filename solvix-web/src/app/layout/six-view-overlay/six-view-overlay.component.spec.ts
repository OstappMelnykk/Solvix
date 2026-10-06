import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import * as THREE from 'three';
import { SixViewOverlayComponent } from './six-view-overlay.component';
import { SixViewOverlayService, SixViewSource } from '../../state/six-view-overlay.service';

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

  it('nodes can be dragged only in a main panel of a World where they are editable', () => {
    overlay.open(source(true));
    expect(component.canDragNodes()).toBeFalse();     // no main panel yet

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

    it('in the Real World first asks to enlarge a view, then explains the drag', () => {
      overlay.open(source(true));
      expect(component.headerHint()).toContain('⤢');

      component.toggleMain(1);
      expect(component.headerHint()).toContain('Тягніть точку');
      expect(component.headerHint()).toContain('Shift');
    });
  });
});
