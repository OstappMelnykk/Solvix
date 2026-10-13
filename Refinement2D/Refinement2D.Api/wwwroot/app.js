import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

// A page to look at the 2D refinement, with three.js: an orthographic camera you can pan and zoom, the cells filled and outlined,
// the cells you pick (M), the nodes each pass marked, and the cells a pass could not cut.
const $ = id => document.getElementById(id);
const canvas = $('view');
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

let state = null;
let shown = new THREE.Group();
scene.add(shown);
const selected = new Set();
let fitted = false;

async function call(path, body) {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (data.state) state = data.state;
    $('problems').textContent = 'Помилка: ' + (data.error ?? response.status);
    build();
    return null;
  }
  state = data;
  return data;
}

// the lattice is in 1/scale of a coarse cell; the world is in coarse cells, so that a drawing keeps its place between refinements
const world = p => new THREE.Vector3(p[0] / state.scale, p[1] / state.scale, 0);

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);
  const half = (camera.top - camera.bottom) / 2 || 1;
  camera.left = (-half * w) / h;
  camera.right = (half * w) / h;
  camera.updateProjectionMatrix();
}

function fit() {
  const xs = state.nodes.map(p => p[0] / state.scale), ys = state.nodes.map(p => p[1] / state.scale);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const { clientWidth: w, clientHeight: h } = canvas;
  const half = Math.max((maxY - minY) / 2, ((maxX - minX) / 2) * (h / w)) * 1.08;
  camera.top = half; camera.bottom = -half; camera.zoom = 1;
  camera.position.set((minX + maxX) / 2, (minY + maxY) / 2, 5);
  controls.target.set((minX + maxX) / 2, (minY + maxY) / 2, 0);
  resize();
  controls.update();
}

function build() {
  scene.remove(shown);
  shown.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
  shown = new THREE.Group();
  scene.add(shown);
  if (!state) return;

  const trace = state.passes;
  const refined = new Set(), unreached = new Set();
  if (trace) for (const p of trace) { for (const a of p.applied) for (const c of a.children) refined.add(c); for (const u of p.unreached ?? []) unreached.add(u); }

  const positions = [], colors = [], lines = [];
  const colour = new THREE.Color();
  for (const cell of state.cells) {
    const p = cell.nodes.map(n => world(state.nodes[n]));
    colour.set(selected.has(cell.id) ? 0xe8e04a : refined.has(cell.id) ? 0xfbf6b4 : 0xffffff);
    if (unreached.has(cell.id) || [...unreached].some(u => false)) colour.set(0xff6b6b);
    for (const t of [[0, 1, 2], [0, 2, 3]]) for (const k of t) { positions.push(p[k].x, p[k].y, 0); colors.push(colour.r, colour.g, colour.b); }
    for (let k = 0; k < 4; k++) lines.push(p[k].x, p[k].y, 0.1, p[(k + 1) % 4].x, p[(k + 1) % 4].y, 0.1);
  }
  const fill = new THREE.BufferGeometry();
  fill.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  fill.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  shown.add(new THREE.Mesh(fill, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  const edges = new THREE.BufferGeometry();
  edges.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  shown.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x666666 })));

  if ($('showRoots').checked) {
    const roots = [];
    for (const r of state.roots) {
      const a = [r.i, r.j], b = [r.i + 1, r.j], c = [r.i + 1, r.j + 1], d = [r.i, r.j + 1];
      for (const [u, v] of [[a, b], [b, c], [c, d], [d, a]]) roots.push(u[0], u[1], 0.2, v[0], v[1], 0.2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(roots, 3));
    shown.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x000000 })));
  }

  if ($('showMarks').checked && trace) {
    const pass = Number($('pass').value);
    const pts = [];
    for (const p of pass < 0 ? trace : trace.filter(t => t.axis === pass))
      for (const id of p.marked) if (state.nodes[id]) { const w = world(state.nodes[id]); pts.push(w.x, w.y, 0.3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    shown.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xd61f1f, size: 7, sizeAttenuation: false })));
  }

  $('undo').disabled = !state.canUndo;
  $('redo').disabled = !state.canRedo;
  $('refine').disabled = selected.size === 0;
  const problems = state.problems ?? [];
  const missed = [...unreached].length;
  $('status').innerHTML = `Клітинок: <b>${state.cells.length}</b>, вузлів: <b>${state.nodes.length}</b> · ` +
    (problems.length === 0 ? '<span class="ok">сітка конформна ✓</span>' : `<span style="color:#ff8b7a">проблем: ${problems.length}</span>`) +
    (missed ? ` · <span style="color:#ff8b7a">не розрізано до кінця: ${missed}</span>` : '');
  $('problems').textContent = problems.slice(0, 12).join('\n');
}

function cellAt(wx, wy) {
  for (const cell of state.cells) {
    const p = cell.nodes.map(n => world(state.nodes[n]));
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++)
      if ((p[i].y > wy) !== (p[j].y > wy) && wx < ((p[j].x - p[i].x) * (wy - p[i].y)) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
    if (inside) return cell.id;
  }
  return null;
}

// a click picks a cell, a drag pans: tell them apart by how far the pointer went
let down = null;
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

const holes = () => $('holes').value.split(';').map(s => s.trim()).filter(Boolean).map(s => s.split(',').map(Number));
$('grid').onclick = async () => { selected.clear(); if (await call('/api/grid', { nx: Number($('nx').value), ny: Number($('ny').value), holes: holes() })) { build(); fit(); } };
$('refine').onclick = async () => { const cells = [...selected]; selected.clear(); await call('/api/refine', { cells, nI: Number($('ni').value), nJ: Number($('nj').value) }); build(); };
$('clear').onclick = () => { selected.clear(); build(); };
$('undo').onclick = async () => { selected.clear(); await call('/api/undo', {}); build(); };
$('redo').onclick = async () => { selected.clear(); await call('/api/redo', {}); build(); };
for (const id of ['showRoots', 'showMarks', 'pass']) $(id).onchange = build;
window.addEventListener('resize', () => { resize(); });

function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); }
fetch('/api/state').then(r => r.json()).then(s => {
  state = s;
  $('nx').value = Math.max(...s.roots.map(r => r.i)) + 1;
  $('ny').value = Math.max(...s.roots.map(r => r.j)) + 1;
  resize(); fit(); build(); loop();
});
