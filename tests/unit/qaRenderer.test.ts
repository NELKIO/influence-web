import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoardRenderer, cellCenter, type BoardView, FOG_START_SCALE, HIDDEN_RADIUS } from '../../src/ui/board/renderer';
import { createMatch, exploredCells, visibleCells } from '../../src/core/engine';
import { buildScenario } from '../../src/core/scenarios';
import type { MatchSettings, MatchState, PlayerType } from '../../src/core/types';

// ---------------------------------------------------------------- a canvas that records what is drawn

type Call = [string, ...unknown[]];

function fakeCanvas() {
  const log: Call[] = [];
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        log.push([String(k), ...a]);
        if (k === 'createLinearGradient') return { addColorStop() {} };
        if (k === 'measureText') return { width: 10 };
        return undefined;
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
  const canvas = { width: 0, height: 0, style: {} as Record<string, string>, getContext: () => ctx };
  return { canvas, log };
}

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let frames: ((t: number) => void)[] = [];
const statics: ReturnType<typeof fakeCanvas>[] = [];
beforeAll(() => {
  for (const k of ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[k] = g[k];
  if (!('window' in g)) g.window = globalThis;
  g.document = {
    createElement: () => {
      const c = fakeCanvas();
      statics.push(c);
      return c.canvas;
    },
  };
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    frames.push(cb);
    return frames.length;
  };
  g.cancelAnimationFrame = () => {};
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

/** Run the pending animation frames once. */
function frame() {
  const f = frames;
  frames = [];
  for (const cb of f) cb(performance.now());
}

function settings(players: PlayerType[], over: Partial<MatchSettings> = {}): MatchSettings {
  return { kind: 'single', size: 'M', players, darkness: true, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false, ...over };
}

function viewOf(s: MatchState): BoardView {
  return {
    state: s,
    visible: visibleCells(s, s.viewer),
    known: exploredCells(s, s.viewer),
    selected: -1,
    targets: new Set(),
    chances: null,
    active: null,
    income: null,
    colorblind: false,
    lineAlpha: 1,
    lowFx: false,
    hover: -1,
  };
}

function make(s: MatchState, w = 400, h = 700) {
  const main = fakeCanvas();
  statics.length = 0;
  const r = new BoardRenderer(main.canvas as unknown as HTMLCanvasElement);
  const layer = statics[0];
  r.resize(w, h);
  r.setView(viewOf(s));
  frame();
  return { r, main, layer };
}

/** Radius each cell was outlined with on the static layer (first hex path starting above its centre). */
function drawnRadius(r: BoardRenderer, layer: ReturnType<typeof fakeCanvas>, s: MatchState, cell: number): number | null {
  const c = s.field.cells[cell];
  const [cx, cy] = r.worldToScreen(...cellCenter(c.x, c.y));
  const log = layer.log;
  for (let k = 0; k + 2 < log.length; k++) {
    const [m, x, y] = log[k];
    if (m !== 'moveTo') continue;
    const rad = cy - (y as number);
    if (Math.abs((x as number) - cx) > 1e-6 || rad <= 0.5 || rad > r.scale * 1.2) continue;
    // a hexagon (not a wall bar, which has a single segment): the next corner lies 60 degrees round
    const [m2, x2, y2] = log[k + 1];
    if (m2 === 'lineTo' && log[k + 2][0] === 'lineTo' && Math.abs((x2 as number) - (cx + rad * Math.cos(-Math.PI / 6))) < 1e-6 && Math.abs((y2 as number) - (cy - rad / 2)) < 1e-6) return rad / r.scale;
  }
  return null;
}

describe('darkness: hidden cells give nothing away', () => {
  it('a hidden cell of capacity 12 is drawn at the same size as any other hidden cell', () => {
    const s = createMatch(settings(['human', 'hunter']), { seed: 21 });
    const vis = visibleCells(s, 0);
    const hidden = s.field.cells.map((_, i) => i).filter((i) => !vis[i]);
    s.field.cells[hidden[0]].maxPower = 12;
    s.field.cells[hidden[1]].maxPower = 8;
    const { r, layer } = make(s);
    expect(drawnRadius(r, layer, s, hidden[0])).toBeCloseTo(HIDDEN_RADIUS, 5);
    expect(drawnRadius(r, layer, s, hidden[1])).toBeCloseTo(HIDDEN_RADIUS, 5);
    // a visible big cell keeps its size
    const seen = s.field.cells.findIndex((_, i) => vis[i]);
    s.field.cells[seen].maxPower = 12;
    layer.log.length = 0;
    r.invalidate();
    frame();
    expect(drawnRadius(r, layer, s, seen)).toBeCloseTo(0.9, 5);
  });

  it('floating texts and rings are never drawn on cells the viewer cannot see', () => {
    const s = createMatch(settings(['human', 'hunter']), { seed: 21 });
    const vis = visibleCells(s, 0);
    const hidden = s.field.cells.findIndex((_, i) => !vis[i]);
    const seen = s.field.cells.findIndex((_, i) => vis[i]);
    const { r, main } = make(s);
    main.log.length = 0;
    r.floatText(hidden, '+7', '#ff0000');
    r.floatText(seen, '+2', '#ff0000');
    frame();
    const texts = main.log.filter((c) => c[0] === 'fillText').map((c) => c[1]);
    expect(texts).toContain('+2');
    expect(texts).not.toContain('+7');
  });

  it("hot-seat hand-over: the previous person's effects are dropped when the viewer changes", () => {
    const s = createMatch(settings(['human', 'hunter', 'human']), { seed: 21 });
    s.viewer = 0;
    const mine = s.field.cells.findIndex((c) => c.owner === 0);
    const { r, main } = make(s);
    r.floatText(mine, '+5', '#ff0000');
    r.ring(mine, '#ff0000', true);
    // the turn passes to seat 2
    s.viewer = 2;
    // seat 2 happens to see that cell too: still nothing of seat 0's turn may show
    const v = viewOf(s);
    v.visible = new Uint8Array(v.visible.length).fill(1);
    r.setView(v);
    main.log.length = 0;
    frame();
    expect(main.log.filter((c) => c[0] === 'fillText').map((c) => c[1])).not.toContain('+5');
    expect((r as unknown as { effects: unknown[] }).effects).toEqual([]);
  });
});

describe('night drop camera on a phone', () => {
  it('starts zoomed in on your land so cells are easy to tap; zooming out shows the whole map; a resize keeps the start camera', () => {
    const s = buildScenario('landing', 7, undefined, ['human', 'god', 'master', 'hunter'], undefined);
    expect(s.settings.blind).toBe(true);
    const { r } = make(s, 390, 640);
    expect(r.fitScale).toBeLessThan(FOG_START_SCALE);
    expect(r.scale).toBeCloseTo(Math.min(r.maxScale, FOG_START_SCALE), 5);
    expect(r.zoomed).toBe(true);
    // centred on what you have seen
    const known = exploredCells(s, 0)!;
    const pts = s.field.cells.flatMap((c, i) => (known[i] ? [cellCenter(c.x, c.y)] : []));
    const mx = (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2;
    const [sx] = r.worldToScreen(mx, 0);
    expect(Math.abs(sx - 195)).toBeLessThan(40);
    // the HUD grows (the board is measured again): the camera stays where it starts
    const cam = [r.scale, r.camX, r.camY];
    r.resize(390, 640);
    expect([r.scale, r.camX, r.camY]).toEqual(cam);
    r.fitView();
    expect(r.scale).toBe(r.fitScale);
    expect(r.zoomed).toBe(false);
  });

  it('a big screen where cells are large enough keeps the fitted scale', () => {
    const s = buildScenario('landing', 7, undefined, ['human', 'god', 'master', 'hunter'], undefined);
    const { r } = make(s, 3000, 2400);
    expect(r.fitScale).toBeGreaterThan(FOG_START_SCALE);
    expect(r.scale).toBe(r.fitScale);
  });
});
