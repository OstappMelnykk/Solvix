// A page to look at the 2D refinement: draws the cells, lets you pick the marked ones, shows the marked nodes of each pass.
const $ = id => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d');
let state = null;
const selected = new Set();
const PAD = 24;

async function call(path, body) {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (data.state) state = data.state;
    $('problems').textContent = 'Помилка: ' + (data.error ?? response.status);
    draw();
    return null;
  }
  state = data;
  return data;
}

function geometry() {
  const nodes = state.nodes;
  const xs = nodes.map(p => p[0]), ys = nodes.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((canvas.width - 2 * PAD) / (maxX - minX), (canvas.height - 2 * PAD) / (maxY - minY));
  // y grows upwards on the lattice, downwards on the screen
  return { at: p => [PAD + (p[0] - minX) * scale, canvas.height - PAD - (p[1] - minY) * scale], scale, minX, minY, maxX, maxY };
}

function polygon(cell, g) {
  return cell.nodes.map(n => g.at(state.nodes[n]));
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state) return;
  const g = geometry();
  const pass = Number($('pass').value);
  const trace = state.passes;
  const refinedNow = new Set();
  if (trace) for (const p of trace) for (const a of p.applied) for (const c of a.children) refinedNow.add(c);

  // cells: the chosen ones yellow, the ones the last refinement made pale
  for (const cell of state.cells) {
    const pts = polygon(cell, g);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = selected.has(cell.id) ? '#e8e04a' : refinedNow.has(cell.id) ? '#fbf6b4' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // the coarse cells, in black
  if ($('showRoots').checked) {
    const d = state.scale;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2.5;
    for (const r of state.roots) {
      const a = g.at([r.i * d, r.j * d]), b = g.at([(r.i + 1) * d, (r.j + 1) * d]);
      ctx.strokeRect(a[0], b[1], b[0] - a[0], a[1] - b[1]);
    }
  }

  // the nodes the passes marked
  if ($('showMarks').checked && trace) {
    ctx.fillStyle = '#d61f1f';
    const passes = pass < 0 ? trace : trace.filter(p => p.axis === pass);
    for (const p of passes) {
      // the marks of an earlier pass were put on the lattice of that time: it was scaled by n after, so use the node ids
      for (const id of p.marked) {
        if (!state.nodes[id]) continue;
        const [x, y] = g.at(state.nodes[id]);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  $('undo').disabled = !state.canUndo;
  $('redo').disabled = !state.canRedo;
  $('refine').disabled = selected.size === 0;
  const problems = state.problems ?? [];
  $('status').innerHTML = `Клітинок: <b>${state.cells.length}</b>, вузлів: <b>${state.nodes.length}</b> · ` + (problems.length === 0 ? '<span class="ok">сітка конформна ✓</span>' : `<span style="color:#ff8b7a">проблем: ${problems.length}</span>`);
  $('problems').textContent = problems.slice(0, 12).join('\n');
}

function cellAt(px, py) {
  const g = geometry();
  for (const cell of state.cells) {
    const pts = polygon(cell, g);
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return cell.id;
  }
  return null;
}

canvas.addEventListener('click', event => {
  if (!state) return;
  const rect = canvas.getBoundingClientRect();
  const id = cellAt((event.clientX - rect.left) * (canvas.width / rect.width), (event.clientY - rect.top) * (canvas.height / rect.height));
  if (id === null) return;
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  draw();
});

function holes() {
  return $('holes').value.split(';').map(s => s.trim()).filter(Boolean).map(s => s.split(',').map(Number));
}

$('grid').onclick = async () => {
  selected.clear();
  await call('/api/grid', { nx: Number($('nx').value), ny: Number($('ny').value), holes: holes() });
  draw();
};
$('refine').onclick = async () => {
  const cells = [...selected];
  selected.clear();
  await call('/api/refine', { cells, nI: Number($('ni').value), nJ: Number($('nj').value) });
  draw();
};
$('clear').onclick = () => { selected.clear(); draw(); };
$('undo').onclick = async () => { selected.clear(); await call('/api/undo', {}); draw(); };
$('redo').onclick = async () => { selected.clear(); await call('/api/redo', {}); draw(); };
for (const id of ['showRoots', 'showMarks', 'pass']) $(id).onchange = draw;

fetch('/api/state').then(r => r.json()).then(s => { state = s; draw(); });
