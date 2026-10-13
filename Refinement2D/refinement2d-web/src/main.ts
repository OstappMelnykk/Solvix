import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshDto, StateDto, StepDto, getState, post, preview } from './api';

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
// the wizard: the stages of a refinement, one at a time (null when it is closed)
let steps: StepDto[] | null = null;
let stepIndex = 0;
let shown = new THREE.Group();
scene.add(shown);
const selected = new Set<number>();

// the lattice is in 1/scale of a coarse cell; the world is in coarse cells, so that a drawing keeps its place between refinements
let view: MeshDto | null = null;
const world = (p: [number, number]): THREE.Vector3 => new THREE.Vector3(p[0] / view!.scale, p[1] / view!.scale, 0);

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

// What to draw: the mesh, the marked nodes, the cells in M, the cells the last refinement made (by template), the cells not cut in full.
interface Scene2D {
  mesh: MeshDto;
  marked: number[];
  m: Set<number>;
  made: Map<number, string>;
  unreached: Set<number>;
}

function currentScene(): Scene2D | null {
  if (steps) {
    const step = steps[stepIndex];
    const made = new Map<number, string>();
    // the cells that came out of the templates (shown on the stage of the templates and on the stage after it)
    if (step.kind === 'templates' || step.kind === 'expand') for (const a of step.applied) for (const c of a.children) made.set(c, a.template);
    return { mesh: step.mesh, marked: step.kind === 'marks' || step.kind === 'templates' ? step.marked : [], m: new Set(step.m), made, unreached: new Set(step.unreached) };
  }
  if (!state) return null;
  const made = new Map<number, string>(), unreached = new Set<number>(), marked: number[] = [];
  const pass = Number($<HTMLSelectElement>('pass').value);
  if (state.passes) for (const p of state.passes) {
    for (const a of p.applied) for (const c of a.children) made.set(c, a.template);
    for (const u of p.unreached ?? []) unreached.add(u);
    if ($<HTMLInputElement>('showMarks').checked && (pass < 0 || p.axis === pass)) marked.push(...p.marked);
  }
  return { mesh: state, marked, m: selected, made, unreached };
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
  const data = currentScene();
  if (!data) return;
  view = data.mesh;

  const positions: number[] = [], colors: number[] = [], lines: number[] = [];
  const colour = new THREE.Color();
  for (const cell of data.mesh.cells) {
    const p = cell.nodes.map(n => world(data.mesh.nodes[n]));
    colour.set(0xffffff);
    const template = data.made.get(cell.id);
    if (template) colour.set(template === 'T1' ? 0xffd8a8 : 0xfbf6b4);
    if (data.m.has(cell.id)) colour.set(0xe8e04a);
    if (data.unreached.has(cell.id)) colour.set(0xff6b6b);
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
    for (const r of data.mesh.roots) {
      const a = [r.i, r.j], b = [r.i + 1, r.j], c = [r.i + 1, r.j + 1], d = [r.i, r.j + 1];
      for (const [u, v] of [[a, b], [b, c], [c, d], [d, a]]) roots.push(u[0], u[1], 0.2, v[0], v[1], 0.2);
    }
    shown.add(lineSegments(roots, 0x000000));
  }

  if (data.marked.length > 0) {
    const pts: number[] = [];
    for (const id of data.marked) if (data.mesh.nodes[id]) { const w = world(data.mesh.nodes[id]); pts.push(w.x, w.y, 0.3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    shown.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xd61f1f, size: 7, sizeAttenuation: false })));
  }

  $<HTMLButtonElement>('undo').disabled = !!steps || !state?.canUndo;
  $<HTMLButtonElement>('redo').disabled = !!steps || !state?.canRedo;
  $<HTMLButtonElement>('refine').disabled = !!steps || selected.size === 0;
  $<HTMLButtonElement>('refineNow').disabled = !!steps || selected.size === 0;
  const problems = data.mesh.problems ?? [];
  const midPass = steps && ['marks'].includes(steps[stepIndex].kind);
  $('status').innerHTML = `Клітинок: <b>${data.mesh.cells.length}</b>, вузлів: <b>${data.mesh.nodes.length}</b> · ` +
    (midPass ? '<span style="color:#9aa0a6">(стан до застосування шаблонів)</span>' : problems.length === 0 ? '<span class="ok">сітка конформна ✓</span>' : `<span style="color:#ff8b7a">проблем: ${problems.length}</span>`) +
    (data.unreached.size ? ` · <span style="color:#ff8b7a">не розрізано до кінця: ${data.unreached.size}</span>` : '');
  $('problems').textContent = midPass ? '' : problems.slice(0, 12).join('\n');
}

function cellAt(wx: number, wy: number): number | null {
  for (const cell of view!.cells) {
    const p = cell.nodes.map(n => world(view!.nodes[n]));
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
  if (!state || steps || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1, y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  const w = new THREE.Vector3(x, y, 0).unproject(camera);
  const id = cellAt(w.x, w.y);
  if (id === null) return;
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  build();
});

// ---- the wizard ---------------------------------------------------------------------------------------------------

const axisName = (axis: number): string => (axis === 0 ? 'X (I)' : 'Y (J)');

function describe(step: StepDto): [string, string] {
  const count = (t: string): number => step.applied.filter(a => a.template === t).length;
  switch (step.kind) {
    case 'start':
      return ['Вибрані клітинки M', 'Жовті клітинки — M, їх треба згустити. Далі алгоритм іде по осі X, потім по Y: на кожній осі позначає вузли, ділить клітинки шаблонами й розширює M.'];
    case 'marks':
      return [`Прохід ${axisName(step.axis)}: позначені вузли`, `Шари вздовж осі йдуть парами (парний + непарний). Червоні вузли лежать на шві пари, в якій є клітинка з M, і на власному шві кожної клітинки з M, до якої шов не дотягся (${step.marked.length} вузлів). Клітинка з одним позначеним вузлом (кут) отримає T1, з двома на ребрі — T2.`];
    case 'templates':
      return [`Прохід ${axisName(step.axis)}: застосовано шаблони`, `Поділено клітинок: ${step.applied.length} (T1 — ${count('T1')}, T2 — ${count('T2')}), n = ${step.n}. Клітинки з T2 розрізані на ${step.n} смуги паралельно позначеному ребру, з T1 — на ${2 * step.n - 1} частин навколо позначеного кута. На спільних ребрах вузли збігаються з обох боків.`];
    case 'expand':
      return [`Розширення M після проходу ${axisName(step.axis)}`, `До M додано всі щойно розділені клітинки (${step.m.length} в M). Наступний прохід позначить вузли й на їхніх швах, тож перехідні шари теж ділитимуться.`];
    default:
      return ['Результат', 'Усі проходи виконано. «Застосувати результат» залишить цю сітку (її можна скасувати), «Закрити» поверне початкову.'];
  }
}

function showStep(): void {
  if (!steps) return;
  const step = steps[stepIndex];
  const [title, text] = describe(step);
  $('wizard').hidden = false;
  $('stepCounter').textContent = `Крок ${stepIndex + 1} з ${steps.length}`;
  $('stepTitle').textContent = title;
  $('stepText').textContent = text;
  $<HTMLButtonElement>('stepBack').disabled = stepIndex === 0;
  $<HTMLButtonElement>('stepNext').hidden = stepIndex === steps.length - 1;
  $<HTMLButtonElement>('stepApply').hidden = stepIndex !== steps.length - 1;
  build();
}

function closeWizard(): void {
  steps = null;
  $('wizard').hidden = true;
  build();
}

$('refine').onclick = async () => {
  const answer = await preview([...selected], value('ni'), value('nj'));
  if ('error' in answer) { $('problems').textContent = 'Помилка: ' + answer.error; return; }
  steps = answer.steps;
  stepIndex = 0;
  showStep();
};
$('stepNext').onclick = () => { if (steps && stepIndex < steps.length - 1) { stepIndex++; showStep(); } };
$('stepBack').onclick = () => { if (steps && stepIndex > 0) { stepIndex--; showStep(); } };
$('stepClose').onclick = closeWizard;
$('stepApply').onclick = async () => {
  const cells = [...selected];
  selected.clear();
  closeWizard();
  await send('/api/refine', { cells, nI: value('ni'), nJ: value('nj') });
};
window.addEventListener('keydown', e => {
  if (!steps) return;
  if (e.key === 'ArrowRight') $('stepNext').click();
  else if (e.key === 'ArrowLeft') $('stepBack').click();
  else if (e.key === 'Escape') closeWizard();
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
$('refineNow').onclick = async () => { const cells = [...selected]; selected.clear(); await send('/api/refine', { cells, nI: value('ni'), nJ: value('nj') }); };
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
