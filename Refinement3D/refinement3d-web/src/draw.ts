// A drawing layer over the whole window. While drawing is off the layer lets every pointer event through to the page,
// so the strokes stay on screen and the program works as usual; while it is on, the mouse draws instead.

interface Stroke { colour: string; width: number; points: [number, number][]; }

export function setupDrawing(): void {
  const layer = document.createElement('canvas');
  layer.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:50;pointer-events:none;touch-action:none';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:60;display:flex;gap:6px;align-items:center;padding:6px 8px;' +
    'background:#26292eee;border:1px solid #3a3f46;border-radius:8px;font:13px system-ui,sans-serif;color:#e6e6e6';
  bar.innerHTML = '<button data-a="toggle" title="Малювати поверх вікна (D)">✎ Малювати</button>' +
    '<input data-a="colour" type="color" value="#ff3b30" title="Колір" style="width:30px;height:26px;padding:0;border:0;background:none">' +
    '<input data-a="width" type="range" min="1" max="20" value="3" title="Товщина" style="width:70px">' +
    '<button data-a="undo" title="Прибрати останню лінію">↶</button>' +
    '<button data-a="clear" title="Стерти все">Стерти</button>';
  document.body.append(layer, bar);

  const ctx = layer.getContext('2d')!;
  const strokes: Stroke[] = [];
  let current: Stroke | null = null;
  let on = false;
  const part = <T extends HTMLElement>(a: string): T => bar.querySelector(`[data-a="${a}"]`) as T;

  function paint(): void {
    ctx.clearRect(0, 0, layer.width, layer.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.strokeStyle = s.colour;
      ctx.fillStyle = s.colour;
      ctx.lineWidth = s.width;
      if (s.points.length === 1) { ctx.beginPath(); ctx.arc(s.points[0][0], s.points[0][1], s.width / 2, 0, Math.PI * 2); ctx.fill(); continue; }
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    }
  }
  function resize(): void {
    const ratio = window.devicePixelRatio || 1;
    layer.width = Math.round(window.innerWidth * ratio);
    layer.height = Math.round(window.innerHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint();
  }
  function setOn(value: boolean): void {
    on = value;
    layer.style.pointerEvents = on ? 'auto' : 'none';
    layer.style.cursor = on ? 'crosshair' : '';
    part('toggle').style.borderColor = on ? '#e8e04a' : '';
    part('toggle').textContent = on ? '✎ Малюю (D — вимкнути)' : '✎ Малювати';
  }

  layer.addEventListener('pointerdown', e => {
    if (!on) return;
    layer.setPointerCapture(e.pointerId);
    current = { colour: part<HTMLInputElement>('colour').value, width: Number(part<HTMLInputElement>('width').value), points: [[e.clientX, e.clientY]] };
    strokes.push(current);
    paint();
  });
  layer.addEventListener('pointermove', e => {
    if (!current) return;
    current.points.push([e.clientX, e.clientY]);
    paint();
  });
  const finish = (): void => { current = null; };
  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', finish);

  part('toggle').onclick = () => setOn(!on);
  part('undo').onclick = () => { strokes.pop(); paint(); };
  part('clear').onclick = () => { strokes.length = 0; paint(); };
  window.addEventListener('keydown', e => {
    const target = e.target as HTMLElement;
    if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) setOn(!on);
  });
  window.addEventListener('resize', resize);
  resize();
}
