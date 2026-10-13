import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshDto, StateDto, StepDto, getState, post, preview } from './api';
import { setupDrawing } from './draw';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const value = (id: string): number => Number($<HTMLInputElement>(id).value);

// ---- the three.js scene ---------------------------------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setClearColor(0xf4f4ef);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f4ef);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
let shown = new THREE.Group();
scene.add(shown);

function resize(): void {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// puts the camera so that the whole mesh is in view (only when a new grid is made, not after every refinement)
function fit(mesh: MeshDto): void {
  const box = new THREE.Box3();
  for (const p of mesh.nodes) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]).divideScalar(mesh.scale));
  const centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(centre);
  camera.position.copy(centre).add(new THREE.Vector3(0.9, -1.3, 1.0).normalize().multiplyScalar(size * 1.6));
  camera.up.set(0, 0, 1);
  camera.near = size / 200;
  camera.far = size * 20;
  camera.updateProjectionMatrix();
  controls.update();
}

// ---- state ----------------------------------------------------------------------------------------------------------

let state: StateDto | null = null;
let view: MeshDto | null = null;                              // the mesh on the screen (the state's, or a wizard stage's)
let steps: StepDto[] | null = null;                           // the wizard: the stages of a refinement, one at a time (null when it is closed)
let stepIndex = 0;
const selected = new Set<number>();                           // the cells in M
let triangleCell: number[] = [];                              // the cell each drawn triangle belongs to (for picking)
let faceMesh: THREE.Mesh | null = null;

const world = (p: [number, number, number]): THREE.Vector3 => new THREE.Vector3(p[0] / view!.scale, p[1] / view!.scale, p[2] / view!.scale);

// What to draw: the mesh, the marked nodes, the cells in M, the cells the last refinement made (by template), the cells not cut in full.
interface Scene3D {
  mesh: MeshDto;
  marked: number[];
  m: Set<number>;
  made: Map<number, string>;
  unreached: Set<number>;
  focus: number | null;                       // the cell a seam of its own is being found for
  spoiled: Set<number>;                       // the cells of M that the attempt would spoil
  trial: number[];                            // the nodes of the face tried
  added: number[];                            // the nodes the completion had to add
}

function currentScene(): Scene3D | null {
  if (steps) {
    const step = steps[stepIndex];
    const mesh = step.mesh ?? steps.slice(0, stepIndex).reverse().find(x => x.kind === 'layers')!.mesh!;
    const made = new Map<number, string>();
    if (step.kind === 'templates' || step.kind === 'expand') for (const a of step.applied) for (const c of a.children) made.set(c, a.template);
    const seam = step.seam;
    return {
      mesh, marked: ['layers', 'seam', 'marks', 'templates'].includes(step.kind) ? step.marked : [], m: new Set(step.m), made, unreached: new Set(step.unreached),
      focus: seam ? seam.cell : null, spoiled: new Set(seam?.spoiled ?? []), trial: seam?.faceNodes ?? [], added: seam?.added ?? []
    };
  }
  if (!state) return null;
  const made = new Map<number, string>(), unreached = new Set<number>(), marked: number[] = [];
  const pass = Number($<HTMLSelectElement>('pass').value);
  if (state.passes) for (const p of state.passes) {
    for (const a of p.applied) for (const c of a.children) made.set(c, a.template);
    for (const u of p.unreached ?? []) unreached.add(u);
    if ($<HTMLInputElement>('showMarks').checked && (pass < 0 || p.axis === pass)) marked.push(...p.marked);
  }
  return { mesh: state, marked, m: selected, made, unreached, focus: null, spoiled: new Set(), trial: [], added: [] };
}

// ---- drawing --------------------------------------------------------------------------------------------------------

const TEMPLATE_COLOUR: Record<string, number> = { T1: 0xffd8a8, T2: 0xfbf6b4, T4: 0xb7d9f2 };
const LIGHT = new THREE.Vector3(0.35, -0.45, 0.82).normalize();

function lineSegments(positions: number[], color: number): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
}

// the corners of a face of a cell in cyclic order (axis: 0..2, side: 0 or 1; the slots are bit0 + 2 bit1 + 4 bit2)
function faceSlots(axis: number, side: number): number[] {
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => (side << axis) | (a << u) | (b << v));
}

// the slab of the coarse grid that is shown: layers lo..hi along the cut axis
function slab(mesh: MeshDto): { axis: number; lo: number; hi: number; max: number } {
  const axis = Number($<HTMLSelectElement>('cutAxis').value);
  const max = axis < 0 ? 0 : Math.max(...mesh.roots.map(r => (axis === 0 ? r.i : axis === 1 ? r.j : r.k)));
  const lo = Math.min(value('cutLo'), max), hi = Math.min(Math.max(value('cutHi'), lo), max);
  return { axis, lo, hi, max };
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
  faceMesh = null;
  triangleCell = [];
  const data = currentScene();
  if (!data) return;
  view = data.mesh;
  const mesh = data.mesh;

  // the cut: which coarse cells are shown
  const cut = slab(mesh);
  const input = $<HTMLInputElement>('cutLo'), inputHi = $<HTMLInputElement>('cutHi');
  input.max = inputHi.max = String(cut.max);
  $('cutText').textContent = cut.axis < 0 ? '' : `Показано шари ${cut.lo}–${cut.hi} з ${cut.max} вздовж ${'XYZ'[cut.axis]}.`;
  const rootShown = mesh.roots.map(r => {
    if (cut.axis < 0) return true;
    const layer = cut.axis === 0 ? r.i : cut.axis === 1 ? r.j : r.k;
    return layer >= cut.lo && layer <= cut.hi;
  });
  const cells = mesh.cells.filter(c => rootShown[c.root]);

  // only the faces that one shown cell has: the outside of the shown block, and the cut
  const count = new Map<string, number>();
  const key = (c: { nodes: number[] }, axis: number, side: number): string => faceSlots(axis, side).map(s => c.nodes[s]).sort((a, b) => a - b).join(',');
  for (const c of cells) for (let axis = 0; axis < 3; axis++) for (let side = 0; side < 2; side++) count.set(key(c, axis, side), (count.get(key(c, axis, side)) ?? 0) + 1);

  const positions: number[] = [], colors: number[] = [], lines: number[] = [];
  const colour = new THREE.Color();
  for (const cell of cells) {
    colour.set(0xffffff);
    const template = data.made.get(cell.id);
    if (template) colour.set(TEMPLATE_COLOUR[template] ?? 0xffffff);
    if (data.m.has(cell.id)) colour.set(0xe8e04a);
    if (data.unreached.has(cell.id)) colour.set(0xff6b6b);
    if (data.spoiled.has(cell.id)) colour.set(0xb03a2e);
    if (data.focus === cell.id) colour.set(0xffb347);
    for (let axis = 0; axis < 3; axis++)
      for (let side = 0; side < 2; side++) {
        if (count.get(key(cell, axis, side)) !== 1) continue;
        const p = faceSlots(axis, side).map(s => world(mesh.nodes[cell.nodes[s]]));
        const normal = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[3], p[0])).normalize();
        const shade = 0.62 + 0.38 * Math.abs(normal.dot(LIGHT));
        for (const t of [[0, 1, 2], [0, 2, 3]]) for (const k of t) {
          positions.push(p[k].x, p[k].y, p[k].z);
          colors.push(colour.r * shade, colour.g * shade, colour.b * shade);
        }
        triangleCell.push(cell.id, cell.id);
        for (let k = 0; k < 4; k++) lines.push(p[k].x, p[k].y, p[k].z, p[(k + 1) % 4].x, p[(k + 1) % 4].y, p[(k + 1) % 4].z);
      }
  }
  const opacity = value('opacity') / 100;
  const fill = new THREE.BufferGeometry();
  fill.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  fill.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  faceMesh = new THREE.Mesh(fill, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
  }));
  shown.add(faceMesh);
  shown.add(lineSegments(lines, 0x555555));

  if ($<HTMLInputElement>('showRoots').checked) {
    const roots: number[] = [];
    for (const r of mesh.roots) {
      if (!rootShown[r.id]) continue;
      const corner = (a: number, b: number, c: number): number[] => [r.i + a, r.j + b, r.k + c];
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
        roots.push(...corner(0, a, b), ...corner(1, a, b), ...corner(a, 0, b), ...corner(a, 1, b), ...corner(a, b, 0), ...corner(a, b, 1));
      }
    }
    shown.add(lineSegments(roots, 0x000000));
  }

  const inSlab = (node: number): boolean => cells.length > 0 && usedNodes(cells).has(node);
  for (const [ids, color, size] of [[data.marked, 0xd61f1f, 8], [data.added, 0x8e44ad, 10], [data.trial, 0xff8c00, 12]] as [number[], number, number][]) {
    if (ids.length === 0) continue;
    const pts: number[] = [];
    for (const id of ids) if (mesh.nodes[id] && inSlab(id)) { const w = world(mesh.nodes[id]); pts.push(w.x, w.y, w.z); }
    if (pts.length === 0) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    shown.add(new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false })));
  }

  $<HTMLButtonElement>('undo').disabled = !!steps || !state?.canUndo;
  $<HTMLButtonElement>('redo').disabled = !!steps || !state?.canRedo;
  $<HTMLButtonElement>('refine').disabled = !!steps || selected.size === 0;
  $<HTMLButtonElement>('refineNow').disabled = !!steps || selected.size === 0;
  const problems = mesh.problems ?? [];
  const midPass = steps && ['layers', 'seam', 'marks'].includes(steps[stepIndex].kind);
  $('status').innerHTML = `Клітинок: <b>${mesh.cells.length}</b>, вузлів: <b>${mesh.nodes.length}</b> · ` +
    (midPass ? '<span style="color:#9aa0a6">(стан до застосування шаблонів)</span>' : problems.length === 0 ? '<span class="ok">сітка конформна ✓</span>' : `<span style="color:#ff8b7a">проблем: ${problems.length}</span>`) +
    (data.unreached.size ? ` · <span style="color:#ff8b7a">не розрізано до кінця: ${data.unreached.size}</span>` : '');
  $('problems').textContent = midPass ? '' : problems.slice(0, 12).join('\n');
}

let usedCache: { cells: unknown; set: Set<number> } | null = null;
function usedNodes(cells: { nodes: number[] }[]): Set<number> {
  if (usedCache?.cells === cells) return usedCache.set;
  const set = new Set<number>();
  for (const c of cells) for (const n of c.nodes) set.add(n);
  usedCache = { cells, set };
  return set;
}

// ---- picking --------------------------------------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
let down: [number, number] | null = null;
canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if (!state || steps || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !faceMesh) return;
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1)), camera);
  const hit = raycaster.intersectObject(faceMesh)[0];
  if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return;
  const id = triangleCell[hit.faceIndex];
  const ids = e.shiftKey ? view!.cells.filter(c => c.root === view!.cells.find(x => x.id === id)!.root).map(c => c.id) : [id];
  const add = !selected.has(id);
  for (const x of ids) if (add) selected.add(x); else selected.delete(x);
  build();
});

// ---- the wizard -----------------------------------------------------------------------------------------------------

const axisName = (axis: number): string => ['X (I)', 'Y (J)', 'Z (K)'][axis];

function describe(step: StepDto): [string, string] {
  const count = (t: string): number => step.applied.filter(a => a.template === t).length;
  switch (step.kind) {
    case 'start':
      return ['Вибрані клітинки M', 'Жовті клітинки — M, їх треба згустити. Далі алгоритм іде по осях X, Y, Z: на кожній позначає вузли, ділить клітинки шаблонами й розширює M.'];
    case 'layers':
      return [`Прохід ${axisName(step.axis)}: шви шарів`, `Позначено вузли на швах пар шарів вихідної сітки (червоні) і дописано вузли, яких не вистачало для дозволених візерунків. Червоні клітинки — клітинки з M, яких ці шви не дісталися: їм треба власний шов (${step.unreached.length}).`];
    case 'seam': {
      const t = step.seam!;
      const verdict = t.accepted ? 'Підходить: залишаю ці мітки.' : !t.cutAcross ? 'Не підходить: після цього клітинка все одно не розрізається впоперек.' : `Не підходить: це зіпсувало б ${t.spoiled.length} інших клітинок M (темно-червоні).`;
      return [`Прохід ${axisName(step.axis)}: власний шов клітинки`, `Оранжева клітинка не дістає до шва. Пробую її ${t.side === 1 ? 'далеку' : 'ближню'} грань (оранжеві вузли)${t.added.length ? ', замикання дописало вузли (фіолетові): ' + t.added.length : ''}. ${verdict}`];
    }
    case 'marks':
      return [`Прохід ${axisName(step.axis)}: усі позначені вузли`, `Остаточні мітки проходу (${step.marked.length} вузлів). Клітинка з одним позначеним вузлом (кут) отримає T1, з двома на ребрі — T2, з чотирма на грані — T4.`];
    case 'templates':
      return [`Прохід ${axisName(step.axis)}: застосовано шаблони`, `Поділено клітинок: ${step.applied.length} (T1 — ${count('T1')}, T2 — ${count('T2')}, T4 — ${count('T4')}), n = ${step.n}. T4 ріже на ${step.n} пластин, T2 — по 2·${step.n}−1 частин, T1 — по 3·${step.n}−2. Грані між сусідами збігаються вузлами.`];
    case 'expand':
      return [`Розширення M після проходу ${axisName(step.axis)}`, `До M додано всі щойно розділені клітинки (${step.m.length} в M). Наступний прохід позначить вузли й на їхніх швах.`];
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
  const answer = await preview([...selected], value('ni'), value('nj'), value('nk'));
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
  await send('/api/refine', { cells, nI: value('ni'), nJ: value('nj'), nK: value('nk') });
};
window.addEventListener('keydown', e => {
  if (!steps || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
  if (e.key === 'ArrowRight') $('stepNext').click();
  else if (e.key === 'ArrowLeft') $('stepBack').click();
  else if (e.key === 'Escape') closeWizard();
});

// ---- the buttons ----------------------------------------------------------------------------------------------------

async function send(path: string, body: unknown, refit = false): Promise<boolean> {
  const answer = await post(path, body);
  if (answer.state) { state = answer.state; if (refit) fit(state); }
  build();
  if ('error' in answer) { $('problems').textContent = 'Помилка: ' + answer.error; return false; }
  return true;
}

$('grid').onclick = async () => {
  const holes = $<HTMLInputElement>('holes').value.split(';').map(s => s.trim()).filter(Boolean).map(s => s.split(',').map(Number));
  selected.clear();
  const ok = await send('/api/grid', { nx: value('nx'), ny: value('ny'), nz: value('nz'), holes }, true);
  if (ok) { $<HTMLSelectElement>('cutAxis').value = '-1'; build(); }
};
$('refineNow').onclick = async () => { const cells = [...selected]; selected.clear(); await send('/api/refine', { cells, nI: value('ni'), nJ: value('nj'), nK: value('nk') }); };
$('clear').onclick = () => { selected.clear(); build(); };
$('undo').onclick = () => { selected.clear(); void send('/api/undo', {}); };
$('redo').onclick = () => { selected.clear(); void send('/api/redo', {}); };
for (const id of ['showRoots', 'showMarks', 'pass', 'cutAxis', 'cutLo', 'cutHi', 'opacity']) $(id).oninput = build;

function loop(): void { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); }

void getState().then(s => { state = s; fit(s); build(); });
loop();
setupDrawing();
