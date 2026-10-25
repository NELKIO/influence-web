import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameController, type AppliedMove, type ControllerOptions } from '../../src/ui/game/controller';
import type { BoardRenderer } from '../../src/ui/board/renderer';
import { alivePlayers, cellsOf, createMatch, isAlive, targetsFrom } from '../../src/core/engine';
import type { MatchSettings, MatchState, PlayerType } from '../../src/core/types';
import { DEFAULT_SETTINGS, type Settings } from '../../src/storage';
import { sfx } from '../../src/audio/sfx';
import type { AttackMove, Bot, BotContext } from '../../src/ai';

// ---------------------------------------------------------------- environment

const g = globalThis as Record<string, unknown>;
const hadWindow = 'window' in g;
const vibrate = vi.fn();
beforeAll(() => {
  // the controller only needs window.setTimeout from the browser
  if (!hadWindow) g.window = globalThis;
  Object.defineProperty(globalThis.navigator, 'vibrate', { value: vibrate, configurable: true });
});
afterAll(() => {
  if (!hadWindow) delete g.window;
  delete (globalThis.navigator as unknown as Record<string, unknown>).vibrate;
});

beforeEach(() => {
  // keep setImmediate real: it lets the bots' promise chain run to the next human turn
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vibrate.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let pending promise chains (bot turns at instant speed) run until nothing is left. */
const flush = () => new Promise<void>((r) => setImmediate(r));
async function settle(c: GameController, rounds = 2000) {
  for (let i = 0; i < rounds; i++) {
    await flush();
    if (!c.busy) {
      await flush();
      if (!c.busy) return;
    }
    vi.advanceTimersByTime(1000);
  }
  throw new Error('bots did not settle');
}

// ---------------------------------------------------------------- fakes

function fakeRenderer() {
  const calls: { m: string; args: unknown[] }[] = [];
  const rec =
    (m: string) =>
    (...args: unknown[]) =>
      void calls.push({ m, args });
  const r = {
    setView: rec('setView'),
    floatText: rec('floatText'),
    fight: rec('fight'),
    ring: rec('ring'),
    ensureVisible: rec('ensureVisible'),
  };
  return { renderer: r as unknown as BoardRenderer, calls, count: (m: string) => calls.filter((c) => c.m === m).length };
}

function settings(over: Partial<MatchSettings> = {}): MatchSettings {
  return { kind: 'single', size: 'S', players: ['human', 'dummy'], darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false, ...over };
}

interface Made {
  c: GameController;
  s: MatchState;
  ends: MatchState[];
  saves: number;
  actions: { seat: number; a: AppliedMove }[];
  r: ReturnType<typeof fakeRenderer>;
}

function make(
  players: PlayerType[],
  opts: { match?: Partial<MatchSettings>; ui?: Partial<Settings>; ctrl?: Partial<ControllerOptions>; seed?: number; prepare?: (s: MatchState) => void } = {},
): Made {
  const s = createMatch(settings({ players, ...opts.match }), { seed: opts.seed ?? 11 });
  opts.prepare?.(s);
  const m: Made = { c: null as unknown as GameController, s, ends: [], saves: 0, actions: [], r: fakeRenderer() };
  m.c = new GameController({
    state: s,
    settings: { ...DEFAULT_SETTINGS, speed: 'instant', confirmEnd: false, ...opts.ui },
    nameOf: (slot) => `P${slot}`,
    t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
    onEnd: (st) => void m.ends.push(st),
    onSave: () => void m.saves++,
    onAction: (seat, a) => void m.actions.push({ seat, a }),
    ...opts.ctrl,
  });
  m.c.attach(m.r.renderer);
  return m;
}

/** An own cell of the current player that can attack, with its first target. */
function attackPair(s: MatchState): [number, number] {
  for (const a of cellsOf(s, s.current)) {
    const ts = targetsFrom(s, a);
    if (ts.length) return [a, ts[0]];
  }
  throw new Error('no attack');
}

/** Hand the whole board to the given owners (shares of the cells), full power. */
function saturate(s: MatchState, owners: number[], shares: number[]) {
  const total = s.field.cells.length;
  let i = 0;
  owners.forEach((o, k) => {
    const n = k === owners.length - 1 ? total - i : Math.round(total * shares[k]);
    for (let j = 0; j < n; j++, i++) {
      s.field.cells[i].owner = o;
      s.field.cells[i].power = s.field.cells[i].maxPower;
    }
  });
}

/** Pass every turn of the local people (attack nothing, auto power) until the match ends. */
async function passUntilEnd(m: Made, maxTurns = 3000) {
  for (let i = 0; i < maxTurns && !m.s.ended && !m.c.state.ended; i++) {
    if (m.c.overlay.kind === 'handover') m.c.dismissHandover();
    else if (m.c.overlay.kind === 'stuck') m.c.acceptStuck(false);
    else if (m.c.isLocalTurn) m.c.endButton(true);
    await settle(m.c);
  }
}

// ---------------------------------------------------------------- tests

describe('tapping in the attack phase', () => {
  it('selects an own cell, shows its targets, attacks a target', async () => {
    const m = make(['human', 'dummy']);
    m.c.start();
    await settle(m.c);
    expect(m.c.isLocalTurn).toBe(true);
    const [a, d] = attackPair(m.s);
    m.c.tap(a);
    expect(m.s.selected).toBe(a);
    const v = m.c.view();
    expect(v.selected).toBe(a);
    expect(v.targets.has(d)).toBe(true);
    // inactive-cell dimming and win chances are on by default
    expect(v.active?.has(a)).toBe(true);
    expect(m.r.count('setView')).toBeGreaterThan(0);

    m.c.tap(d);
    expect(m.actions).toContainEqual({ seat: 0, a: expect.objectContaining({ t: 'attack', from: a, to: d }) });
    expect(m.s.chronicle.attacks).toBe(1);
    expect(m.r.count('fight')).toBe(1);
    expect(m.saves).toBeGreaterThan(0);
  });

  it('a non-adjacent foreign cell clears the selection; nothing selected does nothing', async () => {
    const m = make(['human', 'dummy']);
    m.c.start();
    const [a] = attackPair(m.s);
    const far = m.s.field.cells.findIndex((c, i) => c.owner !== 0 && !m.s.field.adj[a].includes(i));
    m.c.tap(a);
    m.c.tap(far);
    expect(m.s.selected).toBe(-1);
    m.c.tap(far);
    expect(m.s.selected).toBe(-1);
    expect(m.actions).toEqual([]);
  });

  it('settings switch the chance numbers and the dimming off', () => {
    const m = make(['human', 'dummy'], { ui: { showChance: false, inactiveCells: false } });
    m.c.start();
    const [a] = attackPair(m.s);
    m.c.tap(a);
    expect(m.c.view().chances).toBeNull();
    expect(m.c.view().active).toBeNull();
    const n = make(['human', 'dummy']);
    n.c.start();
    const [na, nd] = attackPair(n.s);
    n.c.tap(na);
    // grey empty cells show no chance (always a win); a defended one does
    expect(n.c.view().chances?.has(nd)).toBe(n.s.field.cells[nd].owner >= 0 || n.s.field.cells[nd].power > 0);
    n.s.field.cells[nd].power = 1;
    expect(n.c.view().chances?.get(nd)).toEqual(expect.any(Number));
  });

  it('taps are ignored while an overlay is shown or when it is not your turn', () => {
    const m = make(['human', 'dummy'], { ui: { confirmEnd: true } });
    m.c.start();
    const [a] = attackPair(m.s);
    m.c.pause();
    expect(m.c.overlay.kind).toBe('pause');
    m.c.tap(a);
    expect(m.s.selected).toBe(-1);
    m.c.resume();
    m.c.tap(a);
    expect(m.s.selected).toBe(a);
  });

  it('duel rules: attacking a person past a grey cell shows the hint', () => {
    const m = make(['human', 'dummy'], {
      match: { duelRules: true },
      prepare: (s) => {
        // put an enemy cell and a grey cell next to one of yours
        const a = s.field.cells.findIndex((c) => c.owner === 0);
        const adj = s.field.adj[a];
        expect(adj.length).toBeGreaterThanOrEqual(2);
        for (const c of s.field.cells) if (c.owner === 1) c.owner = -1;
        s.field.cells[adj[0]].owner = 1;
        s.field.cells[adj[0]].power = 1;
        s.field.cells[adj[1]].owner = -1;
        s.field.cells[a].power = 4;
      },
    });
    m.c.start();
    const a = m.s.field.cells.findIndex((c) => c.owner === 0);
    m.c.tap(a);
    m.c.tap(m.s.field.adj[a][0]);
    expect(m.c.hint?.text).toBe('greysFirst');
    expect(m.actions).toEqual([]);
    // the hint goes away by itself
    vi.advanceTimersByTime(3000);
    expect(m.c.hint).toBeNull();
  });
});

describe('the power phase', () => {
  it('a tap adds one; a tap on a foreign cell adds nothing; the last point ends the turn and the bot moves', async () => {
    const m = make(['human', 'dummy']);
    m.c.start();
    m.c.endButton();
    expect(m.s.phase).toBe('power');
    expect(m.s.powerLeft).toBeGreaterThan(0);
    const own = cellsOf(m.s, 0)[0];
    const foreign = m.s.field.cells.findIndex((c) => c.owner === 1);
    const left = m.s.powerLeft;
    m.c.tap(foreign);
    expect(m.s.powerLeft).toBe(left);
    const before = m.s.field.cells[own].power;
    m.c.tap(own);
    expect(m.s.field.cells[own].power).toBe(before + 1);
    expect(m.s.powerLeft).toBe(left - 1);
    expect(m.r.calls.find((c) => c.m === 'floatText')?.args.slice(0, 2)).toEqual([own, '+1']);
    // spend the rest by tapping (cells with room)
    for (let i = 0; i < 200 && m.s.current === 0 && m.s.phase === 'power'; i++) {
      const room = cellsOf(m.s, 0).find((c) => m.s.field.cells[c].power < m.s.field.cells[c].maxPower);
      if (room === undefined) break;
      m.c.tap(room);
    }
    expect(m.actions.some((x) => x.seat === 0 && x.a.t === 'endTurn')).toBe(true);
    await settle(m.c);
    // the dummy took its turn and it is yours again
    expect(m.actions.some((x) => x.seat === 1 && x.a.t === 'endTurn')).toBe(true);
    expect(m.s.current).toBe(0);
    expect(m.s.turn).toBe(1);
    expect(m.c.isLocalTurn).toBe(true);
  });

  it('a long press fills a cell', () => {
    const m = make(['human', 'dummy']);
    m.c.start();
    m.c.endButton();
    // give plenty of points
    m.s.powerLeft = 50;
    const own = cellsOf(m.s, 0)[0];
    m.c.longPress(own);
    expect(m.s.field.cells[own].power).toBe(m.s.field.cells[own].maxPower);
  });

  it('the end button in the power phase places the rest automatically and ends the turn', async () => {
    const m = make(['human', 'dummy']);
    m.c.start();
    m.c.endButton();
    const left = m.s.powerLeft;
    m.c.endButton();
    const mine = m.actions.filter((x) => x.seat === 0 && x.a.t === 'power');
    expect(mine.reduce((n, x) => n + (x.a as { amount: number }).amount, 0)).toBe(left);
    expect(m.actions.filter((x) => x.seat === 0).map((x) => x.a.t).at(-1)).toBe('endTurn');
    await settle(m.c);
    expect(m.s.current).toBe(0);
  });

  it('with "confirm end" on, each phase asks first; a long press (force) skips it', async () => {
    const m = make(['human', 'dummy'], { ui: { confirmEnd: true } });
    m.c.start();
    m.c.endButton();
    expect(m.c.overlay.kind).toBe('confirmEndAttack');
    expect(m.s.phase).toBe('attack');
    m.c.endButton();
    expect(m.c.overlay.kind).toBe('none');
    expect(m.s.phase).toBe('power');
    m.c.endButton();
    expect(m.c.overlay.kind).toBe('confirmAuto');
    expect(m.s.phase).toBe('power');
    // closing the question keeps the phase
    m.c.closeOverlay();
    expect(m.s.phase).toBe('power');
    m.c.endButton(true);
    expect(m.c.overlay.kind).toBe('none');
    await settle(m.c);
    expect(m.s.turn).toBe(1);
    m.c.endButton(true);
    expect(m.s.phase).toBe('power');
  });

  it('no question when nothing can attack any more', () => {
    const m = make(['human', 'dummy'], { ui: { confirmEnd: true }, prepare: (s) => s.field.cells.forEach((c) => c.owner === 0 && (c.power = 1)) });
    m.c.start();
    m.c.endButton();
    expect(m.c.overlay.kind).toBe('none');
    expect(m.s.phase).toBe('power');
  });
});

describe('conceding', () => {
  it('alone against one bot: the match ends at once as a defeat, onEnd once, the result after a pause', async () => {
    const lose = vi.spyOn(sfx, 'lose');
    const m = make(['human', 'dummy']);
    m.c.start();
    m.c.concedeMatch();
    expect(m.s.ended).toMatchObject({ winner: 1, humanWon: false, reason: 'concede' });
    expect(m.ends).toHaveLength(1);
    expect(m.c.overlay.kind).toBe('none');
    vi.advanceTimersByTime(700);
    expect(m.c.overlay.kind).toBe('result');
    expect(lose).toHaveBeenCalledTimes(1);
    // nothing to concede any more
    m.c.concedeMatch();
    m.c.resume();
    m.c.start();
    vi.advanceTimersByTime(700);
    expect(m.ends).toHaveLength(1);
  });

  it('alone against two bots: you leave and the match is over (no person left)', () => {
    const m = make(['human', 'dummy', 'dummy']);
    m.c.start();
    m.c.concedeMatch();
    expect(m.s.ended?.reason).toBe('concede');
    expect(m.s.ended?.humanWon).toBe(false);
    expect(m.ends).toHaveLength(1);
  });

  it('one of two people gives up: the other plays on; then the other gives up too', async () => {
    const m = make(['human', 'human', 'dummy']);
    m.c.start();
    expect(m.c.localHumanSlot()).toBe(0);
    m.c.concedeMatch();
    expect(m.s.ended).toBeNull();
    expect(isAlive(m.s, 0)).toBe(false);
    expect(m.s.viewer).toBe(1);
    expect(m.c.localHumanSlot()).toBe(1);
    await settle(m.c);
    m.c.concedeMatch();
    expect(m.s.ended).toMatchObject({ reason: 'concede', humanWon: false });
    expect(m.ends).toHaveLength(1);
  });

  it('a pause is lifted by conceding', () => {
    const m = make(['human', 'dummy', 'dummy']);
    m.c.start();
    m.c.pause();
    m.c.concedeMatch();
    expect(m.c.overlay.kind).toBe('none');
  });
});

describe('the early-finish offer', () => {
  const stuckBoard = (share: number) => (s: MatchState) => {
    saturate(s, [0, 1], [share, 1 - share]);
    s.turn = 12;
    s.lastStuck = 0;
  };

  it('a saturated board offers it at the start of your turn; accepting with the larger share wins', () => {
    const m = make(['human', 'dummy'], { prepare: stuckBoard(0.6) });
    m.c.start();
    expect(m.c.overlay).toEqual({ kind: 'stuck', offer: expect.objectContaining({ enough: true }) });
    m.c.acceptStuck(true);
    expect(m.s.ended).toMatchObject({ reason: 'early', humanWon: true, winner: 0 });
    expect(m.ends).toHaveLength(1);
    vi.advanceTimersByTime(700);
    expect(m.c.overlay.kind).toBe('result');
  });

  it('with the smaller share accepting is a defeat', () => {
    const m = make(['human', 'dummy'], { prepare: stuckBoard(0.3) });
    m.c.start();
    expect(m.c.overlay).toMatchObject({ kind: 'stuck', offer: { enough: false } });
    m.c.acceptStuck(true);
    expect(m.s.ended).toMatchObject({ reason: 'early', humanWon: false });
  });

  it('declining plays on and does not ask again in the same turn', () => {
    const m = make(['human', 'dummy'], { prepare: stuckBoard(0.6) });
    m.c.start();
    m.c.acceptStuck(false);
    expect(m.c.overlay.kind).toBe('none');
    expect(m.s.ended).toBeNull();
    m.c.pause();
    m.c.resume();
    expect(m.c.overlay.kind).toBe('none');
    // acceptStuck without an offer does nothing
    m.c.acceptStuck(true);
    expect(m.s.ended).toBeNull();
  });

  it('too early in the match: no offer', () => {
    const m = make(['human', 'dummy'], { prepare: (s) => (stuckBoard(0.6)(s), (s.turn = 3)) });
    m.c.start();
    expect(m.c.overlay.kind).toBe('none');
  });
});

describe('hot seat', () => {
  it('in darkness the board stays hidden behind a hand-over screen until the next person is ready', async () => {
    const turn = vi.spyOn(sfx, 'turn');
    const m = make(['human', 'human'], { match: { darkness: true } });
    m.c.start();
    // the first person too gets the screen
    expect(m.c.overlay).toEqual({ kind: 'handover', next: 0 });
    m.c.dismissHandover();
    m.c.endButton(true);
    m.c.endButton(true);
    expect(m.s.current).toBe(1);
    expect(m.c.overlay).toEqual({ kind: 'handover', next: 1 });
    // nothing selectable behind the screen
    const [a] = attackPair(m.s);
    m.c.tap(a);
    expect(m.s.selected).toBe(-1);
    expect(m.c.view().selected).toBe(-1);
    expect(m.s.viewer).toBe(1);
    m.c.dismissHandover();
    expect(m.c.overlay.kind).toBe('none');
    expect(turn).toHaveBeenCalled();
    m.c.tap(a);
    expect(m.s.selected).toBe(a);
    // a second dismiss is a no-op
    m.c.dismissHandover();
    expect(m.c.overlay.kind).toBe('none');
  });

  it('without darkness only a hint names the next person', () => {
    const m = make(['human', 'human']);
    m.c.start();
    m.c.endButton(true);
    m.c.endButton(true);
    expect(m.c.overlay.kind).toBe('none');
    expect(m.c.hint?.text).toBe('handoverNext:{"name":"P1"}');
  });

  it('names: people get numbers in hot seat (eliminated hint), "you" alone', () => {
    const m = make(['human', 'human', 'dummy']);
    expect(m.c.humansCount).toBe(2);
    expect(m.c.name(2)).toBe('P2');
  });
});

describe('bots', () => {
  it('a passive person against Hunter: the bot takes turns until the match ends, onEnd exactly once', async () => {
    const m = make(['human', 'hunter'], { seed: 5 });
    m.c.start();
    await passUntilEnd(m);
    expect(m.s.ended).not.toBeNull();
    expect(m.s.ended?.winner).toBe(1);
    expect(m.s.turn).toBeGreaterThan(1);
    expect(m.ends).toHaveLength(1);
    expect(m.ends[0]).toBe(m.s);
    // the elimination was announced
    expect(m.c.hint?.text).toBe('youEliminated');
    vi.advanceTimersByTime(700);
    expect(m.c.overlay.kind).toBe('result');
    m.c.replaceState(m.s);
    m.c.start();
    vi.advanceTimersByTime(700);
    expect(m.ends).toHaveLength(1);
    expect(m.c.endedAt).toBeGreaterThan(0);
  });

  it('bots only (spectating): they fight on until one wins or the round cap, onEnd once', async () => {
    const win = vi.spyOn(sfx, 'win');
    const m = make(['dummy', 'hunter', 'dummy'], { match: { spectate: 40 }, seed: 3 });
    m.c.start();
    await settle(m.c);
    expect(m.s.ended).not.toBeNull();
    expect(m.s.ended!.reason === 'cap' || alivePlayers(m.s).length === 1).toBe(true);
    expect(m.ends).toHaveLength(1);
    vi.advanceTimersByTime(700);
    // watching bots ends with the "win" jingle
    expect(win).toHaveBeenCalledTimes(1);
  });

  it('a pause holds the bots; resume lets them go on', async () => {
    const m = make(['dummy', 'hunter'], { match: { spectate: 30 }, ui: { speed: 'normal' } });
    m.c.start();
    m.c.pause();
    const turn = m.s.turn;
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1000);
      await flush();
    }
    expect(m.s.turn).toBe(turn);
    m.c.resume();
    for (let i = 0; i < 2000 && !m.s.ended; i++) {
      vi.advanceTimersByTime(1000);
      await flush();
    }
    expect(m.s.ended).not.toBeNull();
    // the bot loop finishes its last pause before it reports the end
    await settle(m.c);
    expect(m.ends).toHaveLength(1);
  });

  it('dispose stops the bots', async () => {
    const m = make(['dummy', 'hunter'], { match: { spectate: 30 }, ui: { speed: 'normal' } });
    m.c.start();
    vi.advanceTimersByTime(1000);
    await flush();
    m.c.dispose();
    const n = m.actions.length;
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(1000);
      await flush();
    }
    expect(m.actions.length).toBe(n);
    expect(m.ends).toHaveLength(0);
  });

  it('an online seat handed to a bot starts moving after refreshBots', async () => {
    const m = make(['human', 'online']);
    m.c.start();
    m.c.endButton(true);
    m.c.endButton(true);
    await settle(m.c);
    // nobody runs the online seat
    expect(m.s.current).toBe(1);
    m.s.settings.players[1] = 'dummy';
    m.c.refreshBots();
    await settle(m.c);
    expect(m.s.current).toBe(0);
    expect(m.actions.some((x) => x.seat === 1 && x.a.t === 'endTurn')).toBe(true);
  });
});

describe('bot pace', () => {
  /** A bot that records the pace it is given and never attacks. */
  function pacer(log: number[]): Bot {
    return {
      type: 'dummy',
      async nextAttack(_s: MatchState, ctx: BotContext): Promise<AttackMove | null> {
        log.push(ctx.speedMs);
        return null;
      },
      async placePower(s: MatchState) {
        return new Map([[cellsOf(s, s.current)[0], 0]]);
      },
    };
  }
  const botSpeed = (c: GameController) => (c as unknown as { botSpeed(): number }).botSpeed();

  it('two bots: full speed; four: half; the spectate speed-up divides it', async () => {
    const two = make(['human', 'dummy', 'dummy'], { ui: { speed: 'slow' } });
    expect(botSpeed(two.c)).toBe(600);
    two.c.spectateSpeedup = 4;
    expect(botSpeed(two.c)).toBe(150);
    const four = make(['human', 'dummy', 'dummy', 'dummy', 'dummy'], { ui: { speed: 'slow' } });
    expect(botSpeed(four.c)).toBe(300);
    four.c.spectateSpeedup = 3;
    expect(botSpeed(four.c)).toBe(100);
    const instant = make(['human', 'dummy']);
    instant.c.spectateSpeedup = 8;
    expect(botSpeed(instant.c)).toBe(0);

    // and the bots get that pace
    const log: number[] = [];
    const m = make(['human', 'dummy', 'dummy'], { ui: { speed: 'normal' } });
    const bots = (m.c as unknown as { bots: Map<number, Bot> }).bots;
    bots.set(1, pacer(log));
    bots.set(2, pacer(log));
    m.c.spectateSpeedup = 5;
    m.c.start();
    m.c.endButton(true);
    m.c.endButton(true);
    await settle(m.c);
    expect(log).toEqual([70, 70]);
  });

  it('at a visible pace a bot shows its selection before the fight', async () => {
    const m = make(['human', 'dummy'], { ui: { speed: 'slow' } });
    m.c.start();
    m.c.endButton(true);
    m.c.endButton(true);
    // the dummy picks its first attack
    for (let i = 0; i < 10 && m.s.selected < 0; i++) await flush();
    expect(m.c.busy).toBe(true);
    expect(m.s.selected).toBeGreaterThanOrEqual(0);
    expect(m.s.field.cells[m.s.selected].owner).toBe(1);
    const fights = m.r.count('fight');
    vi.advanceTimersByTime(299);
    await flush();
    expect(m.r.count('fight')).toBe(fights);
    vi.advanceTimersByTime(2);
    await flush();
    expect(m.r.count('fight')).toBe(fights + 1);
    await settle(m.c);
  });
});

describe('background (no screen)', () => {
  it('no overlays, no sounds, no vibration; bots move; the person’s turn simply waits', async () => {
    const calls: string[] = [];
    for (const k of Object.keys(sfx) as (keyof typeof sfx)[]) vi.spyOn(sfx, k).mockImplementation(() => void calls.push(k));
    const m = make(['human', 'human', 'hunter'], {
      match: { darkness: true },
      ui: { confirmEnd: true },
      ctrl: { background: true },
      prepare: (s) => {
        s.turn = 12;
        s.lastStuck = 0;
      },
    });
    m.c.start();
    expect(m.c.overlay.kind).toBe('none');
    m.c.endButton(true);
    m.c.endButton(true);
    await settle(m.c);
    // seat 1's turn in darkness: no hand-over screen
    expect(m.s.current).toBe(1);
    expect(m.c.overlay.kind).toBe('none');
    m.c.endButton(true);
    m.c.endButton(true);
    await settle(m.c);
    expect(m.actions.some((x) => x.seat === 2 && x.a.t === 'endTurn')).toBe(true);
    expect(m.s.current).toBe(0);
    // the match ends: onEnd, but no result screen
    m.c.concedeMatch();
    await settle(m.c);
    m.c.concedeMatch();
    await settle(m.c);
    expect(m.s.ended).not.toBeNull();
    expect(m.ends).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(m.c.overlay.kind).toBe('none');
    expect(calls).toEqual([]);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('on a screen the same fights do vibrate', async () => {
    const m = make(['human', 'dummy']);
    m.c.start();
    const [a, d] = attackPair(m.s);
    m.c.tap(a);
    m.c.tap(d);
    expect(vibrate).toHaveBeenCalled();
  });
});

describe('localHumanSlot with shuffled seats', () => {
  it('finds you wherever the shuffle put you, also while a bot moves', async () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 8; seed++) {
      const m = make(['human', 'dummy', 'dummy'], { match: { shuffle: true }, seed });
      const you = m.s.settings.players.indexOf('human');
      seen.add(you);
      // before anything ran (it may be a bot's turn)
      expect(m.c.localHumanSlot()).toBe(you);
      m.c.start();
      await settle(m.c);
      expect(m.s.current).toBe(you);
      expect(m.c.localHumanSlot()).toBe(you);
      m.c.concedeMatch();
      expect(m.s.ended?.reason).toBe('concede');
      expect(m.c.localHumanSlot()).toBe(-1);
      m.c.dispose();
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('two people shuffled: the one whose turn it is, else the last viewer', async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const m = make(['human', 'dummy', 'human'], { match: { shuffle: true }, seed });
      m.c.start();
      await settle(m.c);
      const people = m.s.settings.players.map((p, i) => (p === 'human' ? i : -1)).filter((i) => i >= 0);
      expect(people).toContain(m.s.current);
      expect(m.c.localHumanSlot()).toBe(m.s.current);
      m.c.concedeMatch();
      const other = people.find((p) => isAlive(m.s, p))!;
      expect(other).toBeDefined();
      await settle(m.c);
      expect(m.c.localHumanSlot()).toBe(other);
      m.c.dispose();
    }
  });
});

describe('online drivers', () => {
  it('a driver replaces the local moves; canAct decides whose turn is local', () => {
    const attacks: [number, number][] = [];
    let mine = true;
    const m = make(['human', 'remote'], {
      match: { kind: 'duelOnline' },
      ctrl: {
        remoteDriven: true,
        driver: {
          attack: (f, t) => (attacks.push([f, t]), 'notOwn'),
          canAct: () => mine,
        },
      },
    });
    m.c.start();
    const [a, d] = attackPair(m.s);
    m.c.tap(a);
    m.c.tap(d);
    expect(attacks).toEqual([[a, d]]);
    // the local engine did not move
    expect(m.actions).toEqual([]);
    mine = false;
    expect(m.c.isLocalTurn).toBe(false);
    m.c.endButton(true);
    expect(m.s.phase).toBe('attack');
  });

  it('remote fights and power are shown', () => {
    const m = make(['human', 'remote'], { match: { kind: 'duelOnline' }, ctrl: { remoteDriven: true } });
    m.c.start();
    const own = cellsOf(m.s, 1)[0];
    m.c.remotePower(own, 3, 1);
    expect(m.r.calls.at(-2)).toEqual({ m: 'floatText', args: [own, '+3', expect.any(String)] });
    m.c.remoteFight({ type: 'fight', player: 1, from: own, to: m.s.field.adj[own][0], atkBefore: 3, defBefore: 0, atkAfter: 1, defAfter: 2, defOwnerBefore: -1, chance: 1, win: true, eliminated: null });
    expect(m.r.count('fight')).toBe(1);
  });
});
