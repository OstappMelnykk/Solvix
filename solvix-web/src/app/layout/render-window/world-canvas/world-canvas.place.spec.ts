import { ComponentFixture, TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { WorldCanvasComponent } from './world-canvas.component';
import { MeshView } from '../../../geometry/mesh-editor-view';

const hasWebGL = (() => {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
})();

// Real WebGL: in place-on-surface mode a click on the imported surface asks for the selected node to go there.
describe('WorldCanvasComponent: placing a node on the surface by a click', () => {
  let fixture: ComponentFixture<WorldCanvasComponent>;
  let placed: { nodeId: number; position: { x: number; y: number; z: number } }[];

  const frames = (count: number) => new Promise<void>(resolve => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });

  beforeEach(async () => {
    if (!hasWebGL) {
      pending('no WebGL in this browser');
      return;
    }
    fixture = TestBed.createComponent(WorldCanvasComponent);
    const host = fixture.nativeElement as HTMLElement;
    host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px;display:block';
    const c = fixture.componentInstance;
    c.sessionId = 1;
    c.representation = null;
    c.active = true;
    c.worldIndex = 1;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial());
    wall.position.set(0, 0, -3);
    c.importedReference = wall;
    const root = new THREE.Group();
    const node = new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshBasicMaterial());
    node.position.set(0, 0, 0);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial());
    hit.userData['pick'] = { kind: 'node', nodeId: 7 };
    root.add(node, hit);
    const view: MeshView = { root, pickables: [hit], nodeMeshes: new Map([[7, node]]) };
    c.meshView = view;
    c.draggableNodeId = 7;
    c.placeOnSurface = true;
    placed = [];
    c.surfacePlace.subscribe(e => placed.push(e));
    fixture.detectChanges();
    await frames(8);
    fixture.detectChanges();
  });

  afterEach(() => fixture?.destroy());

  const click = (x: number, y: number) => {
    const canvas = (fixture.nativeElement as HTMLElement).querySelector('canvas')!;
    const rect = canvas.getBoundingClientRect();
    const init = { clientX: rect.left + x, clientY: rect.top + y, button: 0, pointerId: 1, bubbles: true };
    canvas.dispatchEvent(new PointerEvent('pointerdown', init));
    canvas.dispatchEvent(new PointerEvent('pointerup', init));
  };

  it('puts the selected node where the surface was clicked', async () => {
    const canvas = (fixture.nativeElement as HTMLElement).querySelector('canvas')!;
    const rect = canvas.getBoundingClientRect();
    click(rect.width * 0.8, rect.height * 0.3);
    expect(placed.length).toBe(1);
    expect(placed[0].nodeId).toBe(7);
    expect(placed[0].position.z).toBeCloseTo(-3, 3);
  });
});
