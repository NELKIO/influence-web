import type { BoardRenderer } from './renderer';

export interface BoardInputHandlers {
  tap(cell: number): void;
  longPress(cell: number): void;
  hover?(cell: number): void;
  /** called when the long press timer starts/ends on a cell (for hold-to-fill feedback) */
  pressStart?(cell: number): void;
  pressEnd?(): void;
}

const LONG_MS = 420;
const MOVE_TOL = 9;

/** Pointer handling: tap, long press, drag-pan, pinch and wheel zoom, double-tap zoom. */
export function attachBoardInput(canvas: HTMLCanvasElement, r: BoardRenderer, h: BoardInputHandlers): () => void {
  const pts = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  let longTimer = 0;
  let longFired = false;
  let moved = false;
  let pinchDist = 0;
  let lastTap = 0;

  const local = (e: PointerEvent | WheelEvent) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top] as const;
  };

  const clearLong = () => {
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = 0;
      h.pressEnd?.();
    }
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    pts.set(e.pointerId, { x, y, sx: x, sy: y });
    if (pts.size === 1) {
      moved = false;
      longFired = false;
      const cell = r.cellAt(x, y);
      if (cell >= 0) {
        h.pressStart?.(cell);
        longTimer = window.setTimeout(() => {
          longTimer = 0;
          if (!moved) {
            longFired = true;
            h.pressEnd?.();
            h.longPress(cell);
          }
        }, LONG_MS);
      }
    } else if (pts.size === 2) {
      clearLong();
      moved = true;
      const [a, b] = [...pts.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const move = (e: PointerEvent) => {
    const [x, y] = local(e);
    const p = pts.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') h.hover?.(r.cellAt(x, y));
      return;
    }
    if (pts.size === 1) {
      if (!moved && Math.hypot(x - p.sx, y - p.sy) > MOVE_TOL) {
        moved = true;
        clearLong();
      }
      if (moved && r.pannable) r.pan(x - p.x, y - p.y);
    } else if (pts.size === 2) {
      const [a, b] = [...pts.entries()].map(([id, v]) => (id === e.pointerId ? { ...v, x, y } : v));
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const pmx = (pts.get([...pts.keys()][0])!.x + pts.get([...pts.keys()][1])!.x) / 2;
      const pmy = (pts.get([...pts.keys()][0])!.y + pts.get([...pts.keys()][1])!.y) / 2;
      if (pinchDist > 0) r.zoomAt(mx, my, d / pinchDist);
      r.pan(mx - pmx, my - pmy);
      pinchDist = d;
    }
    p.x = x;
    p.y = y;
  };

  const up = (e: PointerEvent) => {
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (!p) return;
    const wasLong = longFired;
    clearLong();
    if (pts.size > 0) return;
    if (moved || wasLong) return;
    const now = performance.now();
    const cell = r.cellAt(p.x, p.y);
    if (cell < 0) {
      // double tap on empty space toggles zoom
      if (now - lastTap < 320 && r.canZoom) {
        if (r.zoomed) r.resetCamera();
        else r.zoomTo(p.x, p.y, r.maxScale * 0.8);
        lastTap = 0;
      } else lastTap = now;
      return;
    }
    lastTap = 0;
    h.tap(cell);
  };

  const cancel = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    clearLong();
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = local(e);
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      r.zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    } else {
      r.pan(-e.deltaX, -e.deltaY);
    }
  };

  const leave = () => h.hover?.(-1);
  const ctx = (e: Event) => e.preventDefault();

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', ctx);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', cancel);
    canvas.removeEventListener('pointerleave', leave);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('contextmenu', ctx);
    clearLong();
  };
}
