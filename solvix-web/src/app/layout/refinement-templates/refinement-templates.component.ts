import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, effect, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { RefinementTemplatesService } from '../../state/refinement-templates.service';
import {
  HEX_EDGES,
  HEX_FACES,
  MAX_N,
  MIN_N,
  TEMPLATES,
  TemplateInfo,
  TemplateKind,
  Vec3,
  childCount,
  templateOnUnitCube
} from '../../geometry/refinement-templates';

const PALETTE = ['#39c5f2', '#4ade80', '#f2b33d', '#c77dff', '#ff7a7a', '#7ad0ff', '#a3e635', '#fb923c'];

// The popup with the three transition templates of local refinement (T1, T2, T4): pick one and n, and see how it cuts one
// cell - drag to turn it, wheel to zoom, "Розсунути" to pull the children apart. A plain 2D canvas (no WebGL context: the
// app is already near the browser's limit of them).
@Component({
  selector: 'app-refinement-templates',
  standalone: true,
  imports: [NgFor, NgIf],
  templateUrl: './refinement-templates.component.html',
  styleUrl: './refinement-templates.component.scss'
})
export class RefinementTemplatesComponent implements AfterViewInit, OnDestroy {
  readonly popup = inject(RefinementTemplatesService);
  readonly templates = TEMPLATES;
  readonly minN = MIN_N;
  readonly maxN = MAX_N;

  @ViewChild('canvas') private canvasRef?: ElementRef<HTMLCanvasElement>;

  kind: TemplateKind = 'T1';
  n = 3;
  explode = 0.35;
  private yaw = -0.6;
  private pitch = 0.5;
  private zoom = 1;
  private drag: { x: number; y: number } | null = null;
  private frame = 0;

  constructor() {
    effect(() => {
      if (this.popup.isOpen()) queueMicrotask(() => setTimeout(() => this.draw()));
    });
  }

  get info(): TemplateInfo {
    return this.templates.find((t) => t.kind === this.kind)!;
  }

  get count(): number {
    return childCount(this.kind, this.n);
  }

  ngAfterViewInit(): void {
    this.draw();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frame);
  }

  pick(kind: TemplateKind): void {
    this.kind = kind;
    this.draw();
  }

  setN(delta: number): void {
    this.n = Math.min(MAX_N, Math.max(MIN_N, this.n + delta));
    this.draw();
  }

  onExplode(event: Event): void {
    this.explode = (event.target as HTMLInputElement).valueAsNumber;
    this.draw();
  }

  close(): void {
    this.popup.close();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.popup.isOpen()) this.close();
  }

  onDown(event: PointerEvent): void {
    this.drag = { x: event.clientX, y: event.clientY };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  onMove(event: PointerEvent): void {
    if (!this.drag) return;
    this.yaw += (event.clientX - this.drag.x) * 0.01;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + (event.clientY - this.drag.y) * 0.01));
    this.drag = { x: event.clientX, y: event.clientY };
    this.draw();
  }

  onUp(): void {
    this.drag = null;
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.zoom = Math.min(3, Math.max(0.4, this.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
    this.draw();
  }

  draw(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || !this.popup.isOpen()) return;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { children, markedSlots } = templateOnUnitCube(this.kind, this.n);
    const scale = Math.min(w, h) * 0.34 * this.zoom;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // the point is turned about the cube's centre, then dropped onto the screen (orthographic); depth is kept for the sorting
    const project = (p: Vec3): { x: number; y: number; z: number } => {
      const x = p[0] - 0.5, y = p[1] - 0.5, z = p[2] - 0.5;
      const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      return { x: w / 2 + x1 * scale, y: h / 2 - y1 * scale, z: z2 };
    };

    const shifted = children.map((corners) => {
      const c = corners.reduce<Vec3>((s, q) => [s[0] + q[0] / 8, s[1] + q[1] / 8, s[2] + q[2] / 8], [0, 0, 0]);
      const o: Vec3 = [(c[0] - 0.5) * this.explode, (c[1] - 0.5) * this.explode, (c[2] - 0.5) * this.explode];
      return corners.map((q): Vec3 => [q[0] + o[0], q[1] + o[1], q[2] + o[2]]);
    });

    const faces: { pts: { x: number; y: number }[]; depth: number; color: string }[] = [];
    shifted.forEach((corners, i) => {
      const pr = corners.map(project);
      for (const f of HEX_FACES) {
        faces.push({ pts: f.map((s) => pr[s]), depth: f.reduce((s, k) => s + pr[k].z, 0) / 4, color: PALETTE[i % PALETTE.length] });
      }
    });
    faces.sort((a, b) => b.depth - a.depth);
    for (const f of faces) {
      ctx.beginPath();
      f.pts.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = f.color;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // the marked part of the parent (what the template is built around) in orange, on the parent's own corners
    const parent = [0, 1, 2, 3, 4, 5, 6, 7].map((s): Vec3 => [s & 1, (s >> 1) & 1, (s >> 2) & 1]).map(project);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const [a, b] of HEX_EDGES) {
      ctx.beginPath();
      ctx.moveTo(parent[a].x, parent[a].y);
      ctx.lineTo(parent[b].x, parent[b].y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#da680b';
    ctx.strokeStyle = '#da680b';
    ctx.lineWidth = 4;
    if (this.kind === 'T2') {
      ctx.beginPath();
      ctx.moveTo(parent[markedSlots[0]].x, parent[markedSlots[0]].y);
      ctx.lineTo(parent[markedSlots[1]].x, parent[markedSlots[1]].y);
      ctx.stroke();
    } else if (this.kind === 'T4') {
      const q = [0, 2, 6, 4].map((s) => parent[s]);
      ctx.beginPath();
      q.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.globalAlpha = 0.25;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(parent[0].x, parent[0].y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
