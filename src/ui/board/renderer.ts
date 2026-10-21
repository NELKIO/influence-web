import type { Field, MatchState } from '../../core/types';
import { playerColor, withAlpha } from '../theme';

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
  /** win chance (percent) per target cell, shown as badges */
  chances: Map<number, number> | null;
}

type Effect =
  | { kind: 'fight'; from: number; to: number; win: boolean; color: string; atkColor: string; seed: number; t0: number; dur: number }
  | { kind: 'text'; cell: number; text: string; color: string; t0: number; dur: number }
  | { kind: 'ring'; cell: number; color: string; t0: number; dur: number; big?: boolean };

/** Drawn radius of a cell (world units): big cells (capacity 12) are visibly larger. */
export function cellRadius(maxPower: number): number {
  return maxPower > 8 ? 0.9 : 0.78;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** a*(1-t) + b*t for two hex colours */
function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}

/** lighten (t>0) or darken (t<0) */
function shade(hex: string, t: number): string {
  return mix(hex, t > 0 ? '#ffffff' : '#000000', Math.abs(t));
}

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
      ctx.arc(cx, cy, Math.max(0.1, r * 0.9), 0, Math.PI * 2);
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
  insets = { top: 0, bottom: 0, right: 0 };
  onAnimating: ((busy: boolean) => void) | null = null;
  /** camera (zoom) changed — lets the HUD keep its zoom button in sync */
  onCamera: (() => void) | null = null;

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
    else {
      this.scale = Math.min(this.maxScale, Math.max(this.fitScale, this.scale));
      this.clampCamera();
    }
    this.onCamera?.();
    this.invalidate();
  }

  setView(view: BoardView) {
    // a new field object with the same shape (online resync) keeps the camera
    const prev = this.fieldRef;
    const sameShape =
      !!prev &&
      prev.cells.length === view.state.field.cells.length &&
      prev.w === view.state.field.w &&
      prev.cells.every((c, i) => c.id === view.state.field.cells[i].id);
    const fieldChanged = view.state.field !== prev;
    if (fieldChanged && sameShape) {
      this.fieldRef = view.state.field;
      this.view = view;
      this.invalidate();
      return;
    }
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
    const availH = Math.max(60, this.cssH - this.insets.top - this.insets.bottom);
    const availW = Math.max(60, this.cssW - this.insets.right);
    const w = this.bounds.maxX - this.bounds.minX;
    const h = this.bounds.maxY - this.bounds.minY;
    this.fitScale = Math.max(1, Math.min((availW - 16) / w, (availH - 12) / h));
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
    this.onCamera?.();
  }

  private screenCentre(): [number, number] {
    return [(this.cssW - this.insets.right) / 2, this.insets.top + (this.cssH - this.insets.top - this.insets.bottom) / 2];
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
    this.onCamera?.();
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
    if (x > this.cssW - this.insets.right - m) dx = this.cssW - this.insets.right - m - x;
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

  fight(from: number, to: number, win: boolean, winnerColor: string, attackerColor = winnerColor, dur = 460) {
    if (this.view?.lowFx) dur = Math.min(dur, 160);
    this.effects.push({ kind: 'fight', from, to, win, color: winnerColor, atkColor: attackerColor, seed: Math.random() * 6, t0: performance.now(), dur });
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
    if (this.effects.length || (this.view && (this.view.selected !== -1 || this.view.targets.size))) this.raf = requestAnimationFrame(this.loop);
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
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const pos = this.centers.map(([x, y]) => this.worldToScreen(x, y));
    const onScreen = (i: number) => {
      const [x, y] = pos[i];
      return x > -s * 2 && y > -s * 2 && x < this.cssW + s * 2 && y < this.cssH + s * 2;
    };

    // --- links. Thin hairlines for every passage, thick "bridges" between cells of one owner.
    ctx.lineCap = 'round';
    for (let i = 0; i < cells.length; i++) {
      for (const j of adj[i]) {
        if (j < i || (!v.visible[i] && !v.visible[j]) || (!onScreen(i) && !onScreen(j))) continue;
        const a = cells[i];
        const b = cells[j];
        const bridge = a.owner >= 0 && a.owner === b.owner && v.visible[i] && v.visible[j];
        if (bridge) {
          const grey = v.income && !(v.income.has(i) && v.income.has(j));
          ctx.strokeStyle = grey ? '#3a3e47' : shade(playerColor(a.owner), -0.18);
          ctx.lineWidth = Math.max(2, s * 0.3);
          ctx.globalAlpha = Math.max(0.35, v.lineAlpha);
        } else {
          if (v.lineAlpha <= 0) continue;
          ctx.strokeStyle = 'rgba(255,255,255,0.09)';
          ctx.lineWidth = Math.max(1, s * 0.06);
          ctx.globalAlpha = v.lineAlpha;
        }
        ctx.beginPath();
        ctx.moveTo(pos[i][0], pos[i][1]);
        ctx.lineTo(pos[j][0], pos[j][1]);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // --- walls: a short bar across the gap
    ctx.strokeStyle = 'rgba(200,206,216,0.75)';
    ctx.lineWidth = Math.max(2, s * 0.16);
    ctx.lineCap = 'round';
    for (const [i, j] of walls) {
      if (!v.visible[i] && !v.visible[j]) continue;
      const mx = (pos[i][0] + pos[j][0]) / 2;
      const my = (pos[i][1] + pos[j][1]) / 2;
      const dx = pos[j][0] - pos[i][0];
      const dy = pos[j][1] - pos[i][1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * s * 0.5;
      const ny = (dx / len) * s * 0.5;
      ctx.beginPath();
      ctx.moveTo(mx - nx, my - ny);
      ctx.lineTo(mx + nx, my + ny);
      ctx.stroke();
    }

    // --- cells
    const fontSize = Math.max(8, s * 0.56);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < cells.length; i++) {
      if (!onScreen(i)) continue;
      const c = cells[i];
      const [x, y] = pos[i];
      const r = cellRadius(c.maxPower) * s;
      if (!v.visible[i]) {
        shapePath(ctx, -1, false, x, y, r);
        ctx.fillStyle = '#101216';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        ctx.stroke();
        continue;
      }
      const owner = c.owner;
      const col = playerColor(owner);
      const inactive = v.active !== null && owner === v.state.current && !v.active.has(i);

      // base
      shapePath(ctx, owner, v.colorblind, x, y, r);
      if (owner < 0) {
        ctx.fillStyle = '#1a1d23';
        ctx.fill();
      } else {
        ctx.fillStyle = mix(col, '#17191f', 0.8);
        ctx.fill();
      }

      // power level: flat pigment rising from the bottom
      if (c.power > 0) {
        ctx.save();
        shapePath(ctx, owner, v.colorblind, x, y, r);
        ctx.clip();
        const frac = Math.min(1, c.power / c.maxPower);
        const top = y + r - frac * 2 * r;
        ctx.fillStyle = owner < 0 ? '#3a3f49' : inactive ? mix(col, '#0b0c0f', 0.35) : col;
        ctx.fillRect(x - r * 1.3, top, r * 2.6, y + r - top + 1);
        // light rim on the surface of the level
        if (frac < 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.22)';
          ctx.fillRect(x - r * 1.3, top, r * 2.6, Math.max(1, s * 0.05));
        }
        // subtle top-left sheen for depth
        const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
        g.addColorStop(0, 'rgba(255,255,255,0.10)');
        g.addColorStop(0.5, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        ctx.restore();
      }

      // outline
      shapePath(ctx, owner, v.colorblind, x, y, r);
      ctx.lineWidth = Math.max(1, s * (owner < 0 ? 0.05 : 0.08));
      ctx.strokeStyle = owner < 0 ? '#2c3038' : inactive ? mix(col, '#0b0c0f', 0.3) : shade(col, 0.22);
      ctx.stroke();

      // number
      // owned cells always show their number, even 0 (puzzles start some cells empty)
      if ((c.power > 0 || owner >= 0) && s > 6) {
        const fs = fontSize * (c.maxPower > 8 ? 1.08 : 1);
        ctx.font = `600 ${fs}px Unbounded, Manrope, system-ui, sans-serif`;
        const ty = y + fs * 0.06;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillText(String(c.power), x, ty + Math.max(1, fs * 0.06));
        ctx.fillStyle = owner < 0 ? '#aab0bb' : inactive ? 'rgba(255,255,255,0.6)' : '#ffffff';
        ctx.fillText(String(c.power), x, ty);
      }
    }
  }

  private compose(now: number) {
    const ctx = this.ctx;
    const v = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!v) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const s = this.scale;
    const P = (i: number) => this.worldToScreen(...this.centers[i]);
    const cells = v.state.field.cells;

    // shake the target of a failed attack
    let shakeCell = -1;
    let shake = 0;
    for (const e of this.effects) {
      if (e.kind !== 'fight' || e.win) continue;
      const t = (now - e.t0) / e.dur;
      if (t > 0.38 && t < 0.75) {
        shakeCell = e.to;
        shake = Math.sin((t - 0.38) * 60) * (1 - (t - 0.38) / 0.37) * Math.max(1.5, s * 0.08);
      }
    }
    if (shakeCell >= 0) {
      // draw the static layer, then re-draw the shaken cell area offset
      ctx.drawImage(this.staticLayer, 0, 0, this.canvas.width, this.canvas.height, 0, 0, this.cssW, this.cssH);
      const [x, y] = P(shakeCell);
      const r = cellRadius(cells[shakeCell].maxPower) * s * 1.05;
      ctx.save();
      shapePath(ctx, -1, false, x, y, r);
      ctx.clip();
      ctx.fillStyle = '#0d0e12';
      ctx.fill();
      ctx.drawImage(this.staticLayer, 0, 0, this.canvas.width, this.canvas.height, shake, 0, this.cssW, this.cssH);
      ctx.restore();
    } else {
      ctx.drawImage(this.staticLayer, 0, 0, this.canvas.width, this.canvas.height, 0, 0, this.cssW, this.cssH);
    }

    // targets: dashed outline + win chance badge
    if (v.targets.size) {
      const col = playerColor(v.state.current);
      const k = 0.5 + 0.5 * Math.sin(now / 260);
      for (const i of v.targets) {
        if (!this.centers[i]) continue;
        const [x, y] = P(i);
        const c = cells[i];
        const r = cellRadius(c.maxPower) * s;
        shapePath(ctx, c.owner, v.colorblind, x, y, r + Math.max(2, s * 0.1));
        ctx.setLineDash([Math.max(3, s * 0.22), Math.max(2, s * 0.14)]);
        ctx.lineDashOffset = -now / 40;
        ctx.lineWidth = Math.max(1.5, s * 0.07);
        ctx.strokeStyle = withAlpha(col, 0.6 + 0.35 * k);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // selection
    if (v.selected >= 0 && this.centers[v.selected]) {
      const [x, y] = P(v.selected);
      const c = cells[v.selected];
      const r = cellRadius(c.maxPower) * s;
      shapePath(ctx, c.owner, v.colorblind, x, y, r + Math.max(2.5, s * 0.12));
      ctx.lineWidth = Math.max(2, s * 0.1);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    if (v.hover >= 0 && v.hover !== v.selected && this.centers[v.hover] && v.visible[v.hover]) {
      const [x, y] = P(v.hover);
      const c = cells[v.hover];
      shapePath(ctx, c.owner, v.colorblind, x, y, cellRadius(c.maxPower) * s + 2);
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
        const ease = (u: number) => 1 - (1 - u) * (1 - u);
        if (t < 0.4) {
          // projectile with a short tail in the attacker's colour
          const u = ease(t / 0.4);
          const hx = ax + (bx - ax) * u;
          const hy = ay + (by - ay) * u;
          const tu = Math.max(0, u - 0.35);
          const tx = ax + (bx - ax) * tu;
          const ty = ay + (by - ay) * tu;
          ctx.strokeStyle = e.atkColor;
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(2, s * 0.16);
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(hx, hy, Math.max(1.5, s * 0.1), 0, Math.PI * 2);
          ctx.fill();
        } else {
          const k = (t - 0.4) / 0.6;
          const c = cells[e.to];
          const r = cellRadius(c?.maxPower ?? 8) * s;
          // impact flash on the target
          ctx.save();
          shapePath(ctx, -1, false, bx, by, r);
          ctx.clip();
          ctx.fillStyle = withAlpha(e.win ? '#ffffff' : '#000000', (e.win ? 0.45 : 0.35) * (1 - k));
          ctx.fillRect(bx - r, by - r, r * 2, r * 2);
          ctx.restore();
          // shards
          const n = this.view?.lowFx ? 0 : 9;
          for (let q = 0; q < n; q++) {
            const ang = (q / n) * Math.PI * 2 + e.seed;
            const dist = r * (0.8 + ease(k) * 1.1);
            const px = bx + Math.cos(ang) * dist;
            const py = by + Math.sin(ang) * dist;
            const sz = Math.max(1.5, s * 0.12) * (1 - k);
            ctx.fillStyle = withAlpha(e.color, 1 - k);
            ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
          }
        }
      } else if (e.kind === 'text') {
        if (!this.centers[e.cell]) continue;
        const [x, y] = P(e.cell);
        const ease = 1 - (1 - t) * (1 - t);
        const fs = Math.max(11, Math.min(18, s * 0.42));
        ctx.font = `800 ${fs}px Manrope, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        const ty = y - s * 0.95 - ease * s * 0.6;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillText(e.text, x, ty + 1.5);
        ctx.fillStyle = shade(e.color, 0.25);
        ctx.fillText(e.text, x, ty);
        ctx.globalAlpha = 1;
      } else if (e.kind === 'ring') {
        if (!this.centers[e.cell]) continue;
        const [x, y] = P(e.cell);
        const ease = 1 - (1 - t) * (1 - t);
        hexPath(ctx, x, y, Math.max(0.1, s * (0.9 + ease * (e.big ? 2.6 : 0.8))));
        ctx.strokeStyle = withAlpha(e.color, 1 - t);
        ctx.lineWidth = Math.max(1.5, s * 0.1 * (1 - t) + 1);
        ctx.stroke();
      }
    }
    // win-chance badges go on top of every outline and effect
    if (v.chances && s > 11 && v.selected >= 0 && this.centers[v.selected]) {
      const col = playerColor(v.state.current);
      const [sx, sy] = P(v.selected);
      for (const [i, p] of v.chances) {
        if (!this.centers[i]) continue;
        const [x, y] = P(i);
        const r = cellRadius(cells[i].maxPower) * s;
        // on the far side of the target, away from the selected cell and its white frame
        const dx = x - sx;
        const dy = y - sy;
        const len = Math.hypot(dx, dy) || 1;
        const off = r * 0.98;
        this.badge(ctx, x + (dx / len) * off, y + (dy / len) * off, `${p}%`, p >= 75 ? col : p >= 50 ? '#c9ced8' : '#8d939e', s);
      }
    }
    this.onAnimating?.(this.busy);
  }

  private badge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, s: number) {
    const fs = Math.max(9, Math.min(13, s * 0.36));
    ctx.font = `800 ${fs}px Manrope, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + fs * 0.9;
    const h = fs * 1.55;
    const bx = x - w / 2;
    const by = y - h / 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, h / 2);
    ctx.fillStyle = '#0b0c0f';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(color.startsWith('#') ? color : '#8d939e', 0.7);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }
}
