import type { Field, MatchState } from '../../core/types';
import { playerColor, withAlpha, NEUTRAL_COLOR } from '../theme';

const SQRT3 = Math.sqrt(3);

export interface BoardView {
  state: MatchState;
  /** 1 = visible */
  visible: Uint8Array;
  selected: number;
  /** legal targets of the selected cell */
  targets: Set<number>;
  /** cells of the current player that may still attack (for dimming others) */
  active: Set<number> | null;
  /** duel rules: cells that bring income, by owner; others get grey links */
  income: Set<number> | null;
  colorblind: boolean;
  lineAlpha: number;
  lowFx: boolean;
  /** cell under the pointer (desktop hover) */
  hover: number;
}

type Effect =
  | { kind: 'fight'; from: number; to: number; win: boolean; color: string; t0: number; dur: number }
  | { kind: 'text'; cell: number; text: string; color: string; t0: number; dur: number }
  | { kind: 'ring'; cell: number; color: string; t0: number; dur: number; big?: boolean };

/** Hex centre in world units (cell radius = 1). Odd-r offset layout, pointy-top. */
export function cellCenter(x: number, y: number): [number, number] {
  return [(x + (y % 2 ? 0.5 : 0)) * SQRT3, y * 1.5];
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function polyPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, n: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = ((Math.PI * 2) / n) * i + rot;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Cell outline path. Colour-blind mode gives every owner a distinct shape. */
function shapePath(ctx: CanvasRenderingContext2D, owner: number, colorblind: boolean, cx: number, cy: number, r: number) {
  if (!colorblind) return hexPath(ctx, cx, cy, r);
  switch (owner) {
    case 0:
      return hexPath(ctx, cx, cy, r);
    case 1:
      return polyPath(ctx, cx, cy + r * 0.12, r * 1.08, 3, -Math.PI / 2);
    case 2:
      return polyPath(ctx, cx, cy, r * 1.02, 4, -Math.PI / 2);
    case 3:
      return polyPath(ctx, cx, cy, r * 0.98, 5, -Math.PI / 2);
    case 4:
      return polyPath(ctx, cx, cy, r * 1.0, 4, Math.PI / 4);
    default:
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
  }
}

export class BoardRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private staticLayer: HTMLCanvasElement;
  private view: BoardView | null = null;
  private dirty = true;
  private effects: Effect[] = [];
  private raf = 0;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  /** world bounds */
  private bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  private centers: [number, number][] = [];
  private fieldRef: Field | null = null;
  /** camera: screen = (world - cam) * scale + screen centre */
  scale = 1;
  fitScale = 1;
  camX = 0;
  camY = 0;
  insets = { top: 0, bottom: 0 };
  onAnimating: ((busy: boolean) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.staticLayer = document.createElement('canvas');
    this.loop = this.loop.bind(this);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  resize(cssW: number, cssH: number) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.staticLayer.width = this.canvas.width;
    this.staticLayer.height = this.canvas.height;
    const prevFit = this.fitScale;
    this.computeFit();
    if (!prevFit || this.scale <= prevFit * 1.001) this.resetCamera();
    else this.clampCamera();
    this.invalidate();
  }

  setView(view: BoardView) {
    const fieldChanged = view.state.field !== this.fieldRef;
    this.view = view;
    if (fieldChanged) {
      this.fieldRef = view.state.field;
      this.centers = view.state.field.cells.map((c) => cellCenter(c.x, c.y));
      const xs = this.centers.map((c) => c[0]);
      const ys = this.centers.map((c) => c[1]);
      this.bounds = {
        minX: Math.min(...xs) - 1.05,
        maxX: Math.max(...xs) + 1.05,
        minY: Math.min(...ys) - 1.1,
        maxY: Math.max(...ys) + 1.1,
      };
      this.computeFit();
      this.resetCamera();
    }
    this.invalidate();
  }

  private computeFit() {
    const availH = Math.max(50, this.cssH - this.insets.top - this.insets.bottom);
    const w = this.bounds.maxX - this.bounds.minX;
    const h = this.bounds.maxY - this.bounds.minY;
    this.fitScale = Math.min((this.cssW - 16) / w, (availH - 12) / h);
  }

  get maxScale() {
    // at most ~46px cell radius, at least 2x the fit
    return Math.max(this.fitScale * 1.0001, Math.min(Math.max(46, this.fitScale * 2), this.fitScale * 4));
  }

  get canZoom() {
    return this.maxScale > this.fitScale * 1.15;
  }

  get zoomed() {
    return this.scale > this.fitScale * 1.05;
  }

  resetCamera() {
    this.scale = this.fitScale;
    this.camX = (this.bounds.minX + this.bounds.maxX) / 2;
    this.camY = (this.bounds.minY + this.bounds.maxY) / 2;
    this.invalidate();
  }

  private screenCentre(): [number, number] {
    return [this.cssW / 2, this.insets.top + (this.cssH - this.insets.top - this.insets.bottom) / 2];
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    const [sx, sy] = this.screenCentre();
    return [(wx - this.camX) * this.scale + sx, (wy - this.camY) * this.scale + sy];
  }

  screenToWorld(px: number, py: number): [number, number] {
    const [sx, sy] = this.screenCentre();
    return [(px - sx) / this.scale + this.camX, (py - sy) / this.scale + this.camY];
  }

  /** Zoom keeping the world point under (px,py) fixed. */
  zoomAt(px: number, py: number, factor: number) {
    const [wx, wy] = this.screenToWorld(px, py);
    const next = Math.min(this.maxScale, Math.max(this.fitScale, this.scale * factor));
    this.scale = next;
    const [sx, sy] = this.screenCentre();
    this.camX = wx - (px - sx) / next;
    this.camY = wy - (py - sy) / next;
    this.clampCamera();
    this.invalidate();
  }

  zoomTo(px: number, py: number, target: number) {
    this.zoomAt(px, py, target / this.scale);
  }

  pan(dx: number, dy: number) {
    this.camX -= dx / this.scale;
    this.camY -= dy / this.scale;
    this.clampCamera();
    this.invalidate();
  }

  private clampCamera() {
    const [sx, sy] = this.screenCentre();
    const halfW = sx / this.scale;
    const halfH = (this.cssH - this.insets.top - this.insets.bottom) / 2 / this.scale;
    const { minX, maxX, minY, maxY } = this.bounds;
    const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
    this.camX = clamp(this.camX, minX + halfW - 0.5, maxX - halfW + 0.5);
    this.camY = clamp(this.camY, minY + halfH - 0.5, maxY - halfH + 0.5);
    void sy;
  }

  /** Make sure a cell is on screen (used when following bot moves on zoomed boards). */
  ensureVisible(cell: number) {
    if (!this.zoomed || !this.centers[cell]) return;
    const [x, y] = this.worldToScreen(...this.centers[cell]);
    const m = 40;
    const top = this.insets.top + m;
    const bottom = this.cssH - this.insets.bottom - m;
    let dx = 0;
    let dy = 0;
    if (x < m) dx = m - x;
    if (x > this.cssW - m) dx = this.cssW - m - x;
    if (y < top) dy = top - y;
    if (y > bottom) dy = bottom - y;
    if (dx || dy) this.pan(dx, dy);
  }

  cellAt(px: number, py: number): number {
    if (!this.view) return -1;
    const [wx, wy] = this.screenToWorld(px, py);
    let best = -1;
    let bestD = 0.93 * 0.93;
    this.centers.forEach(([cx, cy], i) => {
      const d = (cx - wx) ** 2 + (cy - wy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  cellScreenPos(cell: number): [number, number] | null {
    const c = this.centers[cell];
    return c ? this.worldToScreen(c[0], c[1]) : null;
  }

  invalidate() {
    this.dirty = true;
    this.kick();
  }

  // ------------------------------------------------------------ effects

  fight(from: number, to: number, win: boolean, winnerColor: string, dur = 420) {
    if (this.view?.lowFx) dur = Math.min(dur, 160);
    this.effects.push({ kind: 'fight', from, to, win, color: winnerColor, t0: performance.now(), dur });
    this.kick();
  }

  floatText(cell: number, text: string, color: string) {
    if (this.view?.lowFx) return;
    // merge with a recent text on the same cell
    const now = performance.now();
    const prev = this.effects.find((e) => e.kind === 'text' && e.cell === cell && now - e.t0 < 500) as
      | Extract<Effect, { kind: 'text' }>
      | undefined;
    if (prev && /^\+\d+$/.test(prev.text) && /^\+\d+$/.test(text)) {
      prev.text = `+${parseInt(prev.text.slice(1)) + parseInt(text.slice(1))}`;
      prev.t0 = now;
    } else {
      this.effects.push({ kind: 'text', cell, text, color, t0: now, dur: 1000 });
    }
    this.kick();
  }

  ring(cell: number, color: string, big = false) {
    if (this.view?.lowFx && !big) return;
    this.effects.push({ kind: 'ring', cell, color, t0: performance.now(), dur: big ? 900 : 500, big });
    this.kick();
  }

  get busy() {
    return this.effects.some((e) => e.kind === 'fight');
  }

  private kick() {
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  private loop(now: number) {
    this.raf = 0;
    this.effects = this.effects.filter((e) => now - e.t0 < e.dur);
    if (this.dirty) {
      this.drawStatic();
      this.dirty = false;
    }
    this.compose(now);
    if (this.effects.length || this.view?.selected !== -1) this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------ drawing

  private drawStatic() {
    const v = this.view;
    const ctx = this.staticLayer.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.staticLayer.width, this.staticLayer.height);
    if (!v) return;
    const { cells, adj, walls } = v.state.field;
    const s = this.scale;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pos = this.centers.map(([x, y]) => this.worldToScreen(x, y));
    const darkness = v.state.settings.darkness;

    // links
    if (v.lineAlpha > 0) {
      ctx.lineCap = 'round';
      for (let i = 0; i < cells.length; i++) {
        for (const j of adj[i]) {
          if (j < i) continue;
          if (!v.visible[i] && !v.visible[j]) continue;
          const a = cells[i];
          const b = cells[j];
          const same = a.owner === b.owner && a.owner >= 0 && v.visible[i] && v.visible[j];
          const neutralPair = a.owner < 0 && b.owner < 0;
          let color = withAlpha(NEUTRAL_COLOR, neutralPair ? 0.35 : 0.6);
          let width = Math.max(1, s * 0.06);
          if (same) {
            const grey = v.income && !(v.income.has(i) && v.income.has(j));
            color = grey ? withAlpha(NEUTRAL_COLOR, 0.9) : withAlpha(playerColor(a.owner), 0.85);
            width = Math.max(1.5, s * 0.13);
          }
          ctx.globalAlpha = v.lineAlpha;
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(pos[i][0], pos[i][1]);
          ctx.lineTo(pos[j][0], pos[j][1]);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // walls: a short bar across the gap between two neighbouring cells
    ctx.strokeStyle = 'rgba(255,120,100,0.32)';
    ctx.lineWidth = Math.max(2, s * 0.12);
    ctx.lineCap = 'round';
    for (const [i, j] of walls) {
      if (!v.visible[i] && !v.visible[j]) continue;
      const mx = (pos[i][0] + pos[j][0]) / 2;
      const my = (pos[i][1] + pos[j][1]) / 2;
      const dx = pos[j][0] - pos[i][0];
      const dy = pos[j][1] - pos[i][1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * s * 0.42;
      const ny = (dx / len) * s * 0.42;
      ctx.beginPath();
      ctx.moveTo(mx - nx, my - ny);
      ctx.lineTo(mx + nx, my + ny);
      ctx.stroke();
    }

    // cells
    const fontSize = Math.max(9, s * 0.62);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const [x, y] = pos[i];
      if (x < -s * 2 || y < -s * 2 || x > this.cssW + s * 2 || y > this.cssH + s * 2) continue;
      const big = c.maxPower > 8;
      const r = s * (big ? 0.9 : 0.78);
      if (!v.visible[i]) {
        shapePath(ctx, -1, false, x, y, r);
        ctx.fillStyle = 'rgba(8,12,24,0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(120,135,170,0.16)';
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.stroke();
        continue;
      }
      const owner = c.owner;
      const col = playerColor(owner);
      const dim = (owner < 0 && c.power === 0) || (v.active !== null && owner === v.state.current && !v.active.has(i));
      ctx.globalAlpha = dim ? 0.55 : 1;

      // body: opaque base so links never show through, then the owner tint
      shapePath(ctx, owner, v.colorblind, x, y, r);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#080c18';
      ctx.fill();
      ctx.globalAlpha = dim ? 0.55 : 1;
      ctx.fillStyle = owner < 0 ? 'rgba(52,60,80,0.5)' : withAlpha(col, 0.14);
      ctx.fill();

      // liquid level
      if (c.power > 0) {
        ctx.save();
        shapePath(ctx, owner, v.colorblind, x, y, r);
        ctx.clip();
        const frac = Math.min(1, c.power / c.maxPower);
        const top = y + r - frac * 2 * r;
        const grad = ctx.createLinearGradient(0, top, 0, y + r);
        grad.addColorStop(0, withAlpha(col, owner < 0 ? 0.35 : 0.95));
        grad.addColorStop(1, withAlpha(col, owner < 0 ? 0.2 : 0.55));
        ctx.fillStyle = grad;
        ctx.fillRect(x - r * 1.2, top, r * 2.4, y + r - top + 1);
        // surface line
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(x - r * 1.2, top, r * 2.4, Math.max(1, s * 0.035));
        ctx.restore();
      }

      // outline (with glow)
      shapePath(ctx, owner, v.colorblind, x, y, r);
      ctx.lineWidth = Math.max(1.2, s * (owner < 0 ? 0.06 : 0.1));
      ctx.strokeStyle = owner < 0 ? 'rgba(150,160,185,0.45)' : col;
      if (!v.lowFx && owner >= 0 && !darkness) {
        ctx.shadowColor = col;
        ctx.shadowBlur = Math.min(14, s * 0.35);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // targets
      if (v.targets.has(i)) {
        shapePath(ctx, owner, v.colorblind, x, y, r * 1.12);
        ctx.setLineDash([Math.max(2, s * 0.18), Math.max(2, s * 0.12)]);
        ctx.lineWidth = Math.max(1.5, s * 0.08);
        ctx.strokeStyle = withAlpha(playerColor(v.state.current), 0.95);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // number
      if (c.power > 0 && s > 7) {
        ctx.font = `700 ${fontSize * (big ? 1.06 : 1)}px "Exo 2", system-ui, sans-serif`;
        ctx.lineWidth = Math.max(2, fontSize * 0.18);
        ctx.strokeStyle = 'rgba(4,6,14,0.75)';
        ctx.strokeText(String(c.power), x, y + fontSize * 0.04);
        ctx.fillStyle = owner < 0 ? '#c9cfdb' : '#ffffff';
        ctx.fillText(String(c.power), x, y + fontSize * 0.04);
      }
      ctx.globalAlpha = 1;
    }
  }

  private compose(now: number) {
    const ctx = this.ctx;
    const v = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticLayer, 0, 0);
    if (!v) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const s = this.scale;
    const P = (i: number) => this.worldToScreen(...this.centers[i]);

    // selection: pulsing ring
    if (v.selected >= 0 && this.centers[v.selected]) {
      const [x, y] = P(v.selected);
      const c = v.state.field.cells[v.selected];
      const r = s * (c.maxPower > 8 ? 0.9 : 0.78);
      const k = 0.5 + 0.5 * Math.sin(now / 180);
      shapePath(ctx, c.owner, v.colorblind, x, y, r * (1.1 + 0.05 * k));
      ctx.lineWidth = Math.max(2, s * 0.12);
      ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.4 * k})`;
      ctx.stroke();
    }
    if (v.hover >= 0 && v.hover !== v.selected && this.centers[v.hover] && v.visible[v.hover]) {
      const [x, y] = P(v.hover);
      const c = v.state.field.cells[v.hover];
      shapePath(ctx, c.owner, v.colorblind, x, y, s * (c.maxPower > 8 ? 0.97 : 0.85));
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.stroke();
    }

    for (const e of this.effects) {
      const t = Math.min(1, (now - e.t0) / e.dur);
      if (e.kind === 'fight') {
        if (!this.centers[e.from] || !this.centers[e.to]) continue;
        const [ax, ay] = P(e.from);
        const [bx, by] = P(e.to);
        const travel = Math.min(1, t / 0.4);
        if (t < 0.55) {
          const hx = ax + (bx - ax) * travel;
          const hy = ay + (by - ay) * travel;
          const tx = ax + (bx - ax) * Math.max(0, travel - 0.35);
          const ty = ay + (by - ay) * Math.max(0, travel - 0.35);
          ctx.strokeStyle = withAlpha(e.color, 0.9 * (1 - t));
          ctx.lineWidth = Math.max(2, s * 0.22);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hx, hy);
          ctx.stroke();
        }
        if (t >= 0.38) {
          const k = (t - 0.38) / 0.62;
          ctx.beginPath();
          ctx.arc(bx, by, s * (0.6 + k * 1.1), 0, Math.PI * 2);
          ctx.strokeStyle = withAlpha(e.color, (1 - k) * 0.9);
          ctx.lineWidth = Math.max(2, s * 0.18 * (1 - k) + 1);
          ctx.stroke();
          if (!e.win) {
            // shield flash on a failed attack
            ctx.beginPath();
            ctx.arc(bx, by, s * 0.95, 0, Math.PI * 2);
            ctx.fillStyle = withAlpha(e.color, 0.25 * (1 - k));
            ctx.fill();
          }
        }
      } else if (e.kind === 'text') {
        if (!this.centers[e.cell]) continue;
        const [x, y] = P(e.cell);
        const ease = 1 - (1 - t) * (1 - t);
        const fs = Math.max(12, s * 0.55);
        ctx.font = `800 ${fs}px "Exo 2", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(e.text, x, y - s * 0.6 - ease * s * 1.1);
        ctx.fillStyle = e.color;
        ctx.fillText(e.text, x, y - s * 0.6 - ease * s * 1.1);
        ctx.globalAlpha = 1;
      } else if (e.kind === 'ring') {
        if (!this.centers[e.cell]) continue;
        const [x, y] = P(e.cell);
        ctx.beginPath();
        ctx.arc(x, y, s * (0.8 + t * (e.big ? 3 : 0.9)), 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(e.color, 1 - t);
        ctx.lineWidth = Math.max(2, s * 0.15 * (1 - t) + 1);
        ctx.stroke();
      }
    }
    const busy = this.busy;
    this.onAnimating?.(busy);
  }
}
