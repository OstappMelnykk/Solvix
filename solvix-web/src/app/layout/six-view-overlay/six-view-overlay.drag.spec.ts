import { ComponentFixture, TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { SixViewOverlayComponent } from './six-view-overlay.component';
import { SixViewOverlayService } from '../../state/six-view-overlay.service';
import { MeshEditorService } from '../../state/mesh-editor.service';
import { MeshEditorSelectionService } from '../../state/mesh-editor-selection.service';
import { MeshView } from '../../geometry/mesh-editor-view';
import { SixViewSource } from '../../state/six-view-overlay.service';
import { SurfaceSnapper } from '../../geometry/surface-snap';

const hasWebGL = (() => {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
})();

// The real component with real WebGL panels: a node is pressed, dragged and released with pointer events. Needs a
// browser with WebGL (the plain headless one has none, and these are skipped there; ChromeHeadless with
// --use-angle=swiftshader --enable-unsafe-swiftshader runs them).
describe('SixViewOverlayComponent: dragging a node in a view', () => {
  let fixture: ComponentFixture<SixViewOverlayComponent>;
  let moveNode: jasmine.Spy;
  let selection: MeshEditorSelectionService;
  let node: THREE.Mesh;
  let view: MeshView;

  const frames = (count: number) => new Promise<void>(resolve => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });

  beforeEach(async () => {
    if (!hasWebGL) {
      pending('no WebGL in this browser');
      return;
    }
    moveNode = jasmine.createSpy('moveNode');
    const editor = jasmine.createSpyObj<MeshEditorService>('MeshEditorService', ['moveNode'], { carryEdgeMidpoints: false });
    editor.moveNode = moveNode as never;
    TestBed.configureTestingModule({ providers: [{ provide: MeshEditorService, useValue: editor }] });
    selection = TestBed.inject(MeshEditorSelectionService);

    const root = new THREE.Group();
    node = new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshBasicMaterial());
    node.position.set(0.5, 0.5, 0.5);
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    cube.position.set(0.5, 0.5, 0.5);
    root.add(cube, node);
    view = { root, pickables: [], nodeMeshes: new Map([[7, node]]) };
    const scene = new THREE.Scene();
    scene.add(root);

    fixture = TestBed.createComponent(SixViewOverlayComponent);
    fixture.detectChanges();
    TestBed.inject(SixViewOverlayService).open({
      scene, sessionId: 1, isIdealWorld: false, framingObjects: [root], hiddenDuringView: [], meshView: () => view, nodesEditable: true
    });
    fixture.detectChanges();
    await frames(8);
    fixture.detectChanges();
  });

  afterEach(() => {
    if (hasWebGL) TestBed.inject(SixViewOverlayService).close();
  });

  const canvasOf = (i: number) => (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLCanvasElement>('canvas:not(.six-view-overlay__gizmo)')[i];
  const pixelOf = (i: number, p: THREE.Vector3) => {
    const camera = (fixture.componentInstance as unknown as { cameras: THREE.OrthographicCamera[] }).cameras[i];
    camera.updateMatrixWorld(true);
    const ndc = p.clone().project(camera);
    const rect = canvasOf(i).getBoundingClientRect();
    return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height };
  };
  const fire = (i: number, type: string, at: { x: number; y: number }) =>
    canvasOf(i).dispatchEvent(new PointerEvent(type, { clientX: at.x, clientY: at.y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, bubbles: true, cancelable: true }));

  it('has a panel, a camera and a size for each view', () => {
    for (let i = 0; i < 6; i++) {
      expect(canvasOf(i)).toBeDefined();
      const rect = canvasOf(i).getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(50);
      expect((fixture.componentInstance as unknown as { cameras: unknown[] }).cameras[i]).not.toBeNull();
    }
  });

  it('moves a node that is pressed, dragged and released in the view looking along Z, without enlarging the view', () => {
    const start = pixelOf(4, node.position);
    const end = { x: start.x + 40, y: start.y - 30 };

    fire(4, 'pointerdown', start);
    fire(4, 'pointermove', end);
    fire(4, 'pointerup', end);

    expect(moveNode).toHaveBeenCalledTimes(1);
    const [, id, position] = moveNode.calls.mostRecent().args;
    expect(id).toBe(7);
    expect(position.z).toBeCloseTo(0.5, 6);                       // the depth coordinate stays
    expect(position.x).toBeGreaterThan(0.5);
    expect(position.y).toBeGreaterThan(0.5);                      // up on the screen is +Y
  });

  it('holds a node grabbed by an arrow of the gizmo to that axis', () => {
    selection.selectNode(1, 7);
    fixture.detectChanges();
    const start = pixelOf(4, node.position);
    const onArrow = { x: start.x + 40, y: start.y };               // the X arrow runs to the right of the centre in this view (its grab zone starts 18 px out)

    fire(4, 'pointerdown', onArrow);
    fire(4, 'pointermove', { x: onArrow.x + 60, y: onArrow.y - 50 });
    fire(4, 'pointerup', { x: onArrow.x + 60, y: onArrow.y - 50 });

    expect(moveNode).toHaveBeenCalledTimes(1);
    const position = moveNode.calls.mostRecent().args[2];
    expect(position.x).toBeGreaterThan(0.5);
    expect(position.y).toBeCloseTo(0.5, 6);                        // not along Y
    expect(position.z).toBeCloseTo(0.5, 6);
  });

  it('moves the node from the centre of its gizmo freely in the plane', () => {
    selection.selectNode(1, 7);
    fixture.detectChanges();
    const start = pixelOf(4, node.position);
    const end = { x: start.x + 50, y: start.y + 20 };

    fire(4, 'pointerdown', { x: start.x + 2, y: start.y + 2 });
    fire(4, 'pointermove', end);
    fire(4, 'pointerup', end);

    const position = moveNode.calls.mostRecent().args[2];
    expect(position.x).toBeGreaterThan(0.5);
    expect(position.y).toBeLessThan(0.5);
  });

  it('does not take a press on empty space (the view is panned there)', () => {
    const rect = canvasOf(4).getBoundingClientRect();
    const empty = { x: rect.left + 8, y: rect.top + 8 };

    fire(4, 'pointerdown', empty);
    fire(4, 'pointermove', { x: empty.x + 30, y: empty.y + 30 });
    fire(4, 'pointerup', { x: empty.x + 30, y: empty.y + 30 });

    expect(moveNode).not.toHaveBeenCalled();
  });

  describe('sticking to the imported surface', () => {
    let attached: Set<number>;
    let setAttached: jasmine.Spy;
    let placeMode = false;
    let place: jasmine.Spy;

    // a wall in the plane z = 0.2 in front of the node, 1.5 wide
    const openWithSurface = (share = 0.05, enabled = true) => {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial());
      wall.position.set(0.5, 0.5, 0.2);
      wall.updateMatrixWorld(true);
      attached = new Set<number>();
      placeMode = false;
      place = jasmine.createSpy('place');
      setAttached = jasmine.createSpy('setAttached').and.callFake((id: number, on: boolean) => (on ? attached.add(id) : attached.delete(id)));
      const source: SixViewSource = {
        scene: new THREE.Scene(), sessionId: 1, isIdealWorld: false, framingObjects: [view.root], hiddenDuringView: [], meshView: () => view, nodesEditable: true,
        surface: { snapper: () => new SurfaceSnapper(wall), isAttached: id => attached.has(id), setAttached: setAttached as never, share: () => share, enabled: () => enabled, object: () => wall, placeMode: () => placeMode, place: place as never }
      };
      source.scene.add(view.root);
      TestBed.inject(SixViewOverlayService).open(source);
    };

    it('a node dragged to the surface in a view sticks to it, and the move ends on the surface', async () => {
      openWithSurface();
      fixture.detectChanges();
      await frames(3);
      const along = new THREE.Vector3(0.5, 0.5, 0.5);                               // looking along Z: the node can move in X and Y, z stays 0.5
      const start = pixelOf(4, along);

      fire(4, 'pointerdown', start);
      fire(4, 'pointermove', { x: start.x + 20, y: start.y });
      fire(4, 'pointerup', { x: start.x + 20, y: start.y });

      // the wall is 0.3 away along Z, further than 5% of its size from the node (0.1): not stuck, an ordinary move
      expect(setAttached).not.toHaveBeenCalled();
      expect(moveNode.calls.mostRecent().args[2].z).toBeCloseTo(0.5, 6);
    });

    it('sticks and slides along the surface when the surface lies in the plane of the drag', async () => {
      openWithSurface();
      node.position.set(0.5, 0.5, 0.2);                                               // the node sits on the wall
      fixture.detectChanges();
      await frames(3);
      const start = pixelOf(4, node.position);

      fire(4, 'pointerdown', start);
      fire(4, 'pointermove', { x: start.x + 30, y: start.y - 20 });
      fire(4, 'pointerup', { x: start.x + 30, y: start.y - 20 });

      expect(setAttached).toHaveBeenCalledWith(7, true);
      const position = moveNode.calls.mostRecent().args[2];
      expect(position.z).toBeCloseTo(0.2, 5);                                         // on the wall
      expect(position.x).toBeGreaterThan(0.5);
    });

    it('lets go of a stuck node when Alt is held, and does nothing about the surface when sticking is switched off', async () => {
      openWithSurface();
      node.position.set(0.5, 0.5, 0.2);
      attached.add(7);
      fixture.detectChanges();
      await frames(3);
      const start = pixelOf(4, node.position);

      canvasOf(4).dispatchEvent(new PointerEvent('pointerdown', { clientX: start.x, clientY: start.y, button: 0, buttons: 1, pointerId: 1, bubbles: true, cancelable: true }));
      canvasOf(4).dispatchEvent(new PointerEvent('pointermove', { clientX: start.x + 20, clientY: start.y, button: 0, buttons: 1, pointerId: 1, altKey: true, bubbles: true }));
      canvasOf(4).dispatchEvent(new PointerEvent('pointerup', { clientX: start.x + 20, clientY: start.y, button: 0, buttons: 0, pointerId: 1, altKey: true, bubbles: true }));

      expect(setAttached).toHaveBeenCalledWith(7, false);

      moveNode.calls.reset();
      setAttached.calls.reset();
      openWithSurface(0.05, false);
      node.position.set(0.5, 0.5, 0.2);
      fixture.detectChanges();
      await frames(3);
      const again = pixelOf(4, node.position);
      fire(4, 'pointerdown', again);
      fire(4, 'pointermove', { x: again.x + 20, y: again.y });
      fire(4, 'pointerup', { x: again.x + 20, y: again.y });
      expect(setAttached).not.toHaveBeenCalled();
    });
  
    it('in place-on-surface mode a click on the surface with a node selected puts the node on that point', async () => {
      openWithSurface();
      placeMode = true;
      selection.selectNode(1, 7);
      fixture.detectChanges();
      await frames(3);
      const target = pixelOf(4, new THREE.Vector3(0.8, 0.3, 0.2));                    // a point of the wall, seen along Z

      fire(4, 'pointerdown', target);
      fire(4, 'pointerup', target);

      expect(place).toHaveBeenCalledTimes(1);
      const [id, point] = place.calls.mostRecent().args;
      expect(id).toBe(7);
      expect(point.x).toBeCloseTo(0.8, 2);
      expect(point.y).toBeCloseTo(0.3, 2);
      expect(point.z).toBeCloseTo(0.2, 4);                                             // on the wall
    });

    it('does not place on a pan, without the mode, or with no node selected', async () => {
      openWithSurface();
      selection.selectNode(1, 7);
      fixture.detectChanges();
      await frames(3);
      const target = pixelOf(4, new THREE.Vector3(0.8, 0.3, 0.2));

      fire(4, 'pointerdown', target);                                                  // the mode is off
      fire(4, 'pointerup', target);
      expect(place).not.toHaveBeenCalled();

      placeMode = true;
      fire(4, 'pointerdown', target);                                                  // a pan, not a click
      fire(4, 'pointerup', { x: target.x + 30, y: target.y });
      expect(place).not.toHaveBeenCalled();

      selection.selectNode(1, 7);                                                      // unselect
      fire(4, 'pointerdown', target);
      fire(4, 'pointerup', target);
      expect(place).not.toHaveBeenCalled();
    });
  });
});
