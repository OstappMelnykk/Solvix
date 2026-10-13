import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { StateDto, getState, post } from './api';

// A page to look at the 2D refinement: an orthographic camera you can pan and zoom, the cells filled and outlined, the cells you pick
// (M), the nodes each pass marked, and the cells a pass could not cut.
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f4f0);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
camera.position.z = 5;
const controls = new OrbitControls(camera, canvas);
controls.enableRotate = false;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };

let state: StateDto | null = null;
let shown = new THREE.Group();
scene.add(shown);
const selected = new Set<number>();

// the lattice is in 1/scale of a coarse cell; the world is in coarse cells, so that a drawing keeps its place between refinements
const world = (p: [number, number]): THREE.Vector3 => new THREE.Vector3(p[0] / state!.scale, p[1] / state!.scale, 0);

function resize(): void {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);
  const half = (camera.top - camera.bottom) / 2 || 1;
  camera.left = (-half * w) / h;
  camera.right = (half * w) / h;
  camera.updateProjectionMatrix();
}

function fit(): void {
  if (!state) return;
  const xs = state.nodes.map(p => p[0] / state!.scale), ys = state.nodes.map(p => p[1] / state!.scale);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const { clientWidth: w, clientHeight: h } = canvas;
  const half = Math.max((maxY - minY) / 2, ((maxX - minX) / 2) * (h / w)) * 1.08;
  camera.top = half;
  camera.bottom = -half;
  camera.zoom = 1;
  camera.position.set((minX + maxX) / 2, (minY + maxY) / 2, 5);
  controls.target.set((minX + maxX) / 2, (minY + maxY) / 2, 0);
  resize();
  controls.update();
}

function lineSegments(positions: number[], color: number): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
}

function build(): void {
  scene.remove(shown);
  shown.traverse(o => {
    const object = o as THREE.Mesh;
    object.geometry?.dispose();
    (object.material as THREE.Material | undefined)?.dispose?.();
  });
  shown = new THREE.Group();
  scene.add(shown);
  if (!state) return;

  const trace = state.passes;
  const refined = new Set<number>(), unreached = new Set<number>();
  if (trace) for (const p of trace) {
    for (const a of p.applied) for (const c of a.children) refined.add(c);
    for (const u of p.unreached ?? []) unreached.add(u);
  }

  const positions: number[] = [], colors: number[] = [], lines: number[] = [];
  const colour = new THREE.Color();
  for (const cell of state.cells) {
    const p = cell.nodes.map(n => world(state!.nodes[n]));
    colour.set(selected.has(cell.id) ? 0xe8e04a : refined.has(cell.id) ? 0xfbf6b4 : 0xffffff);
    if (unreached.has(cell.id)) colour.set(0xff6b6b);
    for (const t of [[0, 1, 2], [0, 2, 3]]) for (const k of t) { positions.push(p[k].x, p[k].y, 0); colors.push(colour.r, colour.g, colour.b); }
    for (let k = 0; k < 4; k++) lines.push(p[k].x, p[k].y, 0.1, p[(k + 1) % 4].x, p[(k + 1) % 4].y, 0.1);
  }
  const fill = new THREE.BufferGeometry();
  fill.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  fill.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  shown.add(new THREE.Mesh(fill, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  shown.add(lineSegments(lines, 0x666666));

  if ($<HTMLInputElement>('showRoots').checked) {
    const roots: number[] = [];
    for (const r of state.roots) {
      const a = [r.i, r.j], b = [r.i + 1, r.j], c = [r.i + 1, r.j + 1], d = [r.i, r.j + 1];
      for (const [u, v] of [[a, b], [b, c], [c, d], [d, a]]) roots.push(u[0], u[1], 0.2, v[0], v[1], 0.2);
    }
    shown.add(lineSegments(roots, 0x000000));
  }

  if ($<HTMLInputElement>('showMarks').checked && trace) {
    const pass = Number($<HTMLSelectElement>('pass').value);
    const pts: number[] = [];
    for (const p of pass < 0 ? trace : trace.filter(t => t.axis === pass))
      for (const id of p.marked) if (state.nodes[id]) { const w = world(state.nodes[id]); pts.push(w.x, w.y, 0.3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    shown.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xd61f1f, size: 7, sizeAttenuation: false })));
  }

  $<HTMLButtonElement>('undo').disabled = !state.canUndo;
  $<HTMLButtonElement>('redo').disabled = !state.canRedo;
  $<HTMLButtonElement>('refine').disabled = selected.size === 0;
  const problems = state.problems ?? [];
  $('status').innerHTML = `Клітинок: <b>${state.cells.length}</b>, вузлів: <b>${state.nodes.length}</b> · ` +
    (problems.length === 0 ? '<span class="ok">сітка конформна ✓</span>' : `<span style="color:#ff8b7a">проблем: ${problems.length}</span>`) +
    (unreached.size ? ` · <span style="color:#ff8b7a">не розрізано до кінця: ${unreached.size}</span>` : '');
  $('problems').textContent = problems.slice(0, 12).join('\n');
}

function cellAt(wx: number, wy: number): number | null {
  for (const cell of state!.cells) {
    const p = cell.nodes.map(n => world(state!.nodes[n]));
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++)
      if ((p[i].y > wy) !== (p[j].y > wy) && wx < ((p[j].x - p[i].x) * (wy - p[i].y)) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
    if (inside) return cell.id;
  }
  return null;
}

// a click picks a cell, a drag pans: tell them apart by how far the pointer went
let down: [number, number] | null = null;
canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if (!state || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1, y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  const w = new THREE.Vector3(x, y, 0).unproject(camera);
  const id = cellAt(w.x, w.y);
  if (id === null) return;
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  build();
});

async function send(path: string, body: unknown): Promise<boolean> {
  const answer = await post(path, body);
  if (answer.state) state = answer.state;
  $('problems').textContent = 'error' in answer ? 'Помилка: ' + answer.error : '';
  build();
  return !('error' in answer);
}

const holes = (): number[][] => $<HTMLInputElement>('holes').value.split(';').map(s => s.trim()).filter(Boolean).map(s => s.split(',').map(Number));
const value = (id: string): number => Number($<HTMLInputElement>(id).value);
$('grid').onclick = async () => { selected.clear(); if (await send('/api/grid', { nx: value('nx'), ny: value('ny'), holes: holes() })) fit(); };
$('refine').onclick = async () => { const cells = [...selected]; selected.clear(); await send('/api/refine', { cells, nI: value('ni'), nJ: value('nj') }); };
$('clear').onclick = () => { selected.clear(); build(); };
$('undo').onclick = async () => { selected.clear(); await send('/api/undo', {}); };
$('redo').onclick = async () => { selected.clear(); await send('/api/redo', {}); };
for (const id of ['showRoots', 'showMarks', 'pass']) $(id).onchange = build;
window.addEventListener('resize', resize);

function loop(): void { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); }
getState().then(s => {
  state = s;
  $<HTMLInputElement>('nx').value = String(Math.max(...s.roots.map(r => r.i)) + 1);
  $<HTMLInputElement>('ny').value = String(Math.max(...s.roots.map(r => r.j)) + 1);
  resize();
  fit();
  build();
  loop();
});
