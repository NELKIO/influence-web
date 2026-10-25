import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameController, type AppliedMove } from '../../src/ui/game/controller';
import type { BoardRenderer } from '../../src/ui/board/renderer';
import { createMatch, targetsFrom, cellsOf } from '../../src/core/engine';
import type { MatchSettings, MatchState, PlayerType } from '../../src/core/types';
import { DEFAULT_SETTINGS, type Settings } from '../../src/storage';
import type { AttackMove, Bot } from '../../src/ai';

// ---------------------------------------------------------------- environment

const g = globalThis as Record<string, unknown>;
const hadWindow = 'window' in g;
beforeAll(() => {
  if (!hadWindow) g.window = globalThis;
});
afterAll(() => {
  if (!hadWindow) delete g.window;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = () => new Promise<void>((r) => setImmediate(r));
async function flushAll(n = 20) {
  for (let i = 0; i < n; i++) await flush();
}

function fakeRenderer() {
  const noop = () => {};
  return { setView: noop, floatText: noop, fight: noop, ring: noop, ensureVisible: noop } as unknown as BoardRenderer;
}

/** A bot whose moves the test hands out one by one (each call waits for the test to answer). */
class ScriptedBot implements Bot {
  readonly type = 'dummy' as const;
  attacks: ((m: AttackMove | null) => void)[] = [];
  placements = 0;
  nextAttack(): Promise<AttackMove | null> {
    return new Promise((r) => this.attacks.push(r));
  }
  async placePower(): Promise<Map<number, number>> {
    this.placements++;
    return new Map();
  }
  answer(m: AttackMove | null) {
    const r = this.attacks.shift();
    if (!r) throw new Error('the bot is not thinking');
    r(m);
  }
}

function settings(players: PlayerType[], over: Partial<MatchSettings> = {}): MatchSettings {
  return { kind: 'single', size: 'S', players, darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false, ...over };
}

function make(s: MatchState, ui: Partial<Settings> = {}) {
  const ends: MatchState[] = [];
  const actions: { seat: number; a: AppliedMove }[] = [];
  const c = new GameController({
    state: s,
    settings: { ...DEFAULT_SETTINGS, speed: 'instant', confirmEnd: false, ...ui },
    nameOf: (slot) => `P${slot}`,
    t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
    onEnd: (st) => void ends.push(st),
    onAction: (seat, a) => void actions.push({ seat, a }),
  });
  c.attach(fakeRenderer());
  const bots = (c as unknown as { bots: Map<number, Bot> }).bots;
  const script = (seat: number) => {
    const b = new ScriptedBot();
    bots.set(seat, b);
    return b;
  };
  return { c, s, ends, actions, script };
}

/** Lay out a small board by hand: every cell neutral and empty, then the given owners and powers. */
function layout(s: MatchState, cells: [cell: number, owner: number, power: number][]) {
  for (const c of s.field.cells) {
    c.owner = -1;
    c.power = 0;
  }
  for (const [i, o, p] of cells) {
    s.field.cells[i].owner = o;
    s.field.cells[i].power = p;
  }
}

/** Three cells in a row: a - b - c with a and c not neighbours. */
function chain(s: MatchState): [number, number, number] {
  const { adj } = s.field;
  for (let a = 0; a < adj.length; a++)
    for (const b of adj[a])
      for (const c of adj[b]) if (c !== a && !adj[a].includes(c)) return [a, b, c];
  throw new Error('no chain');
}

// ---------------------------------------------------------------- tests

describe('conceding while a bot is thinking', () => {
  it('the bot step planned before the match ended is never applied (no "illegal attack ... ended")', async () => {
    const s = createMatch(settings(['human', 'dummy', 'dummy']), { seed: 9 });
    const m = make(s);
    const b1 = m.script(1);
    m.script(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.c.start();
    // the person ends the turn: bot 1 starts thinking
    m.c.endButton(true);
    if (s.current === 0) m.c.endButton(true);
    await flushAll();
    expect(s.current).toBe(1);
    expect(b1.attacks.length).toBe(1);
    const own = cellsOf(s, 1).find((i) => targetsFrom(s, i).length)!;
    const move = { from: own, to: targetsFrom(s, own)[0] };
    // pause, give up from the pause menu: no person left, the match is over
    m.c.pause();
    m.c.concedeMatch();
    expect(s.ended).not.toBeNull();
    const board = JSON.stringify(s.field);
    const acted = m.actions.length;
    // the bot answers only now
    b1.answer(move);
    await flushAll();
    vi.advanceTimersByTime(2000);
    await flushAll();
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(s.field)).toBe(board);
    expect(m.actions.length).toBe(acted);
    expect(m.c.busy).toBe(false);
    expect(m.ends.length).toBe(1);
  });

  it('a step planned on a board that changed under it (a seat left) is planned again, not applied', async () => {
    const s = createMatch(settings(['human', 'dummy', 'human', 'dummy']), { seed: 9 });
    const m = make(s);
    const b1 = m.script(1);
    m.script(3);
    s.current = 1;
    s.viewer = 0;
    m.c.start();
    await flushAll();
    expect(b1.attacks.length).toBe(1);
    const own = cellsOf(s, 1).find((i) => targetsFrom(s, i).length)!;
    m.c.pause();
    m.c.concedeMatch();
    expect(s.ended).toBeNull();
    const acted = m.actions.length;
    b1.answer({ from: own, to: targetsFrom(s, own)[0] });
    await flushAll();
    // nothing applied: the bot is asked again
    expect(m.actions.length).toBe(acted);
    expect(b1.attacks.length).toBe(1);
  });
});

describe("a bot's attack is shown before it is rolled", () => {
  it('its cell is selected and its target marked during the pause', async () => {
    const s = createMatch(settings(['human', 'dummy']), { seed: 9 });
    const m = make(s, { speed: 'normal' });
    const b1 = m.script(1);
    s.current = 1;
    m.c.start();
    await flushAll();
    const own = cellsOf(s, 1).find((i) => targetsFrom(s, i).length)!;
    const to = targetsFrom(s, own)[0];
    b1.answer({ from: own, to });
    await flushAll();
    const v = m.c.view();
    expect(v.selected).toBe(own);
    expect([...v.targets]).toEqual([to]);
    // no win chances for somebody else's attack
    expect(v.chances).toBeNull();
    vi.advanceTimersByTime(1000);
    await flushAll();
    expect(m.c.view().selected).toBe(-1);
  });

  it('in darkness only what the viewer sees: a cell in the dark stays unmarked', async () => {
    const s = createMatch(settings(['human', 'dummy'], { darkness: true }), { seed: 9 });
    const [h, t, f] = chain(s);
    layout(s, [
      [h, 0, 3],
      [f, 1, 6],
    ]);
    s.current = 1;
    const m = make(s, { speed: 'normal' });
    const b1 = m.script(1);
    m.c.start();
    await flushAll();
    b1.answer({ from: f, to: t });
    await flushAll();
    const v = m.c.view();
    expect(v.visible[f]).toBe(0);
    expect(v.visible[t]).toBe(1);
    expect(v.selected).toBe(-1);
    expect([...v.targets]).toEqual([t]);
  });
});

describe('hot-seat darkness: the seat looking at the board goes out', () => {
  it('eliminated by a bot: the view moves to the next person, after a hand-over', async () => {
    const s = createMatch(settings(['human', 'dummy', 'human'], { darkness: true }), { seed: 9 });
    const [x, y, z] = chain(s);
    const far = s.field.cells.findIndex((_, i) => i !== x && i !== y && i !== z && !s.field.adj[i].some((j) => j === x || j === y || j === z));
    layout(s, [
      [x, 0, 1],
      [y, 1, 8],
      [z, 1, 2],
      [far, 2, 4],
    ]);
    s.current = 1;
    s.viewer = 0;
    const m = make(s);
    const b1 = m.script(1);
    m.c.start();
    await flushAll();
    b1.answer({ from: y, to: x });
    await flushAll();
    // seat 0 is out while the bot is still moving
    expect(s.field.cells[x].owner).toBe(1);
    expect(s.viewer).toBe(2);
    expect(m.c.overlay).toEqual({ kind: 'handover', next: 2 });
    // the board is not black for the new viewer
    expect([...m.c.view().visible].some(Boolean)).toBe(true);
    m.c.dismissHandover();
    b1.answer(null);
    await flushAll();
    // seat 2's turn: the device is already in their hands, no second hand-over
    expect(s.current).toBe(2);
    expect(m.c.overlay.kind).toBe('none');
    expect(m.c.isLocalTurn).toBe(true);
  });

  it('a person gives up and one person is left: the device is handed over before their board shows', async () => {
    const s = createMatch(settings(['human', 'human', 'dummy'], { darkness: true }), { seed: 9 });
    const m = make(s);
    m.script(2);
    m.c.start();
    // the first person takes the device
    expect(m.c.overlay).toEqual({ kind: 'handover', next: 0 });
    m.c.dismissHandover();
    m.c.pause();
    m.c.concedeMatch();
    expect(s.ended).toBeNull();
    expect(s.current).toBe(1);
    expect(s.viewer).toBe(1);
    expect(m.c.overlay).toEqual({ kind: 'handover', next: 1 });
  });
});

describe('the end of a match is reported once, by the screen that saw it end', () => {
  it('a match that was already over when opened again is not reported (no second record)', async () => {
    const s = createMatch(settings(['human', 'dummy']), { seed: 9 });
    s.ended = { winner: 0, humanWon: true, reason: 'concede', turn: 3 };
    const m = make(s);
    m.c.start();
    vi.advanceTimersByTime(1000);
    await flushAll();
    expect(m.ends.length).toBe(0);
    // the result window is still shown
    expect(m.c.overlay.kind).toBe('result');
  });

  it('a match that ends while it is watched is reported once', async () => {
    const s = createMatch(settings(['human', 'dummy', 'dummy']), { seed: 9 });
    const m = make(s);
    m.c.start();
    m.c.concedeMatch();
    m.c.start();
    vi.advanceTimersByTime(1000);
    await flushAll();
    expect(m.ends.length).toBe(1);
  });
});
