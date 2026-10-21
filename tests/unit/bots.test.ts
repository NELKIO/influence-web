import { describe, expect, it } from 'vitest';
import { createBot } from '../../src/ai';
import { runMatch } from '../../src/ai/arena';
import { DummyBot } from '../../src/ai/dummy';
import { DuelHunterBot } from '../../src/ai/duelHunter';
import { FreakBot } from '../../src/ai/freak';
import { HunterBot, lazyTarget } from '../../src/ai/hunter';
import { MasterBrain, __test } from '../../src/ai/master';
import { MasterBot, isValidPlacement } from '../../src/ai/masterBot';
import type { Bot } from '../../src/ai/types';
import { smartyPower } from '../../src/ai/common';
import { Rng } from '../../src/core/rng';
import {
  addPower,
  attack,
  checkAttack,
  createMatch,
  endAttack,
  finishTurn,
  targetsFrom,
} from '../../src/core/engine';
import { NEUTRAL, type BotType, type MatchSettings, type MatchState } from '../../src/core/types';

const ctx = { speedMs: 0 };

const base: MatchSettings = {
  kind: 'single',
  size: 'M',
  players: ['hunter', 'dummy'],
  darkness: false,
  symmetry: false,
  crowded: false,
  unions: false,
  shuffle: false,
  duelRules: false,
};

/** Hand-made line board 0-1-2-...; owners/powers per cell. */
function lineMatch(powers: number[], owners: number[], opts: Partial<MatchSettings> = {}, caps?: number[]): MatchState {
  const m = createMatch({ ...base, ...opts }, { seed: 1 });
  m.field = {
    size: 'S',
    w: 5,
    h: 7,
    cells: powers.map((p, i) => ({ id: i, x: i, y: 0, power: p, maxPower: caps?.[i] ?? 8, owner: owners[i] })),
    adj: powers.map((_, i) => [i - 1, i + 1].filter((j) => j >= 0 && j < powers.length)),
    walls: [],
    starts: [0, 1, 2, 3, 0],
  };
  return m;
}

/** Collect a variety of mid-game states by playing a few Hunter/Dummy matches. */
function sampleStates(settings: Partial<MatchSettings>, seeds: number[]): MatchState[] {
  const out: MatchState[] = [];
  for (const seed of seeds) {
    const s = createMatch({ ...base, players: ['dummy', 'hunter', 'freak'], ...settings }, { seed });
    const bots = [new DummyBot(), new HunterBot(seed), new FreakBot(seed)];
    let steps = 0;
    while (!s.ended && s.turn < 12 && steps++ < 400) {
      const b = bots[s.current] as DummyBot | HunterBot | FreakBot;
      out.push(structuredClone(s));
      const mv = b.pickAttack(s);
      if (mv) {
        attack(s, mv.from, mv.to);
        if ((s.ended as MatchState['ended'])?.winner === -1) s.ended = null;
        continue;
      }
      endAttack(s);
      out.push(structuredClone(s));
      for (const [c, k] of smartyPower(s)) addPower(s, c, k);
      finishTurn(s);
    }
  }
  return out;
}

const fast = { sync: true, playouts: 20 } as const;

function makeBot(t: BotType, seed = 1): Bot {
  return createBot(t, { seed, master: fast });
}

async function checkBotOnStates(t: BotType, states: MatchState[]) {
  for (const st of states) {
    const snap = JSON.stringify(st);
    const bot = makeBot(t);
    if (st.phase === 'attack') {
      const mv = await bot.nextAttack(st, ctx);
      if (mv) expect(checkAttack(st, mv.from, mv.to)).toBeNull();
    } else {
      const pl = await bot.placePower(st, ctx);
      expect(isValidPlacement(st, pl)).toBe(true);
    }
    expect(JSON.stringify(st)).toBe(snap); // never mutates the passed state
  }
}

describe('bots: legality, power sums, no mutation', () => {
  const normal = sampleStates({}, [1, 2, 3]).filter((_, i) => i % 3 === 0);
  const duel = sampleStates({ duelRules: true, players: ['dummy', 'hunter'] }, [4, 5]).filter((_, i) => i % 3 === 0);
  const crowded = sampleStates({ crowded: true, size: 'S' }, [6]).filter((_, i) => i % 2 === 0);
  for (const t of ['freak', 'dummy', 'hunter', 'duelHunter', 'master'] as BotType[]) {
    it(`${t} returns legal moves and exact placements`, async () => {
      await checkBotOnStates(t, normal);
      await checkBotOnStates(t, duel);
      await checkBotOnStates(t, crowded);
    });
  }

  it('createBot builds every type', () => {
    for (const t of ['freak', 'dummy', 'hunter', 'duelHunter', 'master'] as BotType[]) {
      const b = createBot(t, { master: fast });
      expect(b.type).toBe(t);
      b.dispose?.();
    }
  });
});

describe('edge cases', () => {
  it('bots return null outside of their attack phase / when nothing can attack', async () => {
    // own cells all at power 1
    const s = lineMatch([1, 1, 0, 1], [0, 0, NEUTRAL, 1]);
    for (const t of ['freak', 'dummy', 'hunter', 'duelHunter', 'master'] as BotType[]) {
      expect(await makeBot(t).nextAttack(s, ctx)).toBeNull();
    }
  });

  it('a player with no border cell (disconnected map) does not hang', async () => {
    // 0-1 own, 2-3 enemy, no link between 1 and 2
    const s = lineMatch([5, 5, 3, 3], [0, 0, 1, 1]);
    s.field.adj = [[1], [0], [3], [2]];
    for (const t of ['freak', 'dummy', 'hunter', 'duelHunter', 'master'] as BotType[]) {
      expect(await makeBot(t).nextAttack(s, ctx)).toBeNull();
    }
    endAttack(s);
    for (const t of ['freak', 'dummy', 'hunter', 'duelHunter', 'master'] as BotType[]) {
      const pl = await makeBot(t).placePower(s, ctx);
      expect(isValidPlacement(s, pl)).toBe(true);
    }
  });

  it('placement with zero income is empty', async () => {
    const s = lineMatch([8, 8, 1], [0, 0, 1]);
    endAttack(s);
    expect(s.powerLeft).toBe(0);
    for (const t of ['freak', 'dummy', 'hunter', 'duelHunter', 'master'] as BotType[]) {
      expect((await makeBot(t).placePower(s, ctx)).size).toBe(0);
    }
  });

  it('placement respects capacities when free room is tight', async () => {
    const s = lineMatch([7, 8, 7, 1], [0, 0, 0, 1]);
    endAttack(s);
    expect(s.powerLeft).toBe(2);
    for (const t of ['freak', 'dummy', 'hunter', 'duelHunter', 'master'] as BotType[]) {
      const pl = await makeBot(t).placePower(s, ctx);
      expect(isValidPlacement(s, pl)).toBe(true);
    }
  });
});

describe('Dummy', () => {
  it('attacks from the first usable cell into its first non-own neighbour', () => {
    const s = lineMatch([1, 3, 0, 2, 4], [0, 0, NEUTRAL, 1, 1]);
    expect(new DummyBot().pickAttack(s)).toEqual({ from: 1, to: 2 });
  });

  it('spreads power round-robin over all own cells', async () => {
    const s = lineMatch([1, 1, 1, 0], [0, 0, 0, NEUTRAL]);
    endAttack(s);
    const pl = await new DummyBot().placePower(s, ctx);
    expect([...pl.entries()].sort()).toEqual([[0, 1], [1, 1], [2, 1]]);
  });

  it('is deterministic', async () => {
    const st = sampleStates({}, [9]).filter((s) => s.phase === 'attack');
    const a = st.map((s) => new DummyBot().pickAttack(s));
    const b = st.map((s) => new DummyBot().pickAttack(s));
    expect(a).toEqual(b);
  });
});

describe('Hunter', () => {
  it('attacks from its strongest border cell into the weakest neighbour', () => {
    // 0(3) 1(6) 2(5,enemy) 3(0,grey) — strongest border cell is 1, its targets: 2 only (0 is own)
    const s = lineMatch([3, 6, 5, 4], [0, 0, 1, 1]);
    expect(new HunterBot(1).pickAttack(s)).toEqual({ from: 1, to: 2 });
  });

  it('prefers neutral targets', () => {
    const s = lineMatch([0, 6, 2], [NEUTRAL, 0, 1]);
    expect(new HunterBot(1).pickAttack(s)).toEqual({ from: 1, to: 0 });
  });

  it('lazy target index-0 quirk', () => {
    const s = lineMatch([3, 3, 3], [1, 0, 1]);
    expect(lazyTarget(s, [0, 2], new Rng(1))).toBe(0);
  });

  it('never stops while a border cell can attack (even at bad odds)', () => {
    const s = lineMatch([2, 8], [0, 1]);
    expect(new HunterBot(1).pickAttack(s)).toEqual({ from: 0, to: 1 });
  });

  it('puts power on border cells first', async () => {
    // 0 interior, 1 border (next to enemy 2)
    const s = lineMatch([1, 1, 1], [0, 0, 1]);
    endAttack(s); // income 2
    const pl = await new HunterBot(1).placePower(s, ctx);
    expect([...pl.entries()]).toEqual([[1, 2]]);
  });

  it('is deterministic for a seed', async () => {
    const st = sampleStates({}, [10]).filter((s) => s.phase === 'attack');
    const a = st.map((s) => new HunterBot(5).pickAttack(s));
    const b = st.map((s) => new HunterBot(5).pickAttack(s));
    expect(a).toEqual(b);
  });
});

describe('Duel Hunter', () => {
  it('attacks greys first even when an enemy is weaker', () => {
    const s = lineMatch([0, 5, 1], [NEUTRAL, 0, 1], { duelRules: true });
    s.field.cells[0].power = 0;
    const mv = new DuelHunterBot(1).pickAttack(s);
    expect(mv).toEqual({ from: 1, to: 0 });
    expect(targetsFrom(s, 1)).toEqual([0]);
  });
});

describe('Freak', () => {
  it('is deterministic for a seed and only plays legal moves', () => {
    const st = sampleStates({}, [11]).filter((s) => s.phase === 'attack');
    const a = st.map((s) => new FreakBot(3).pickAttack(s));
    const b = st.map((s) => new FreakBot(3).pickAttack(s));
    expect(a).toEqual(b);
    st.forEach((s, i) => a[i] && expect(checkAttack(s, a[i]!.from, a[i]!.to)).toBeNull());
  });
});

describe('Master', () => {
  const { Board, Topo, FastRng, SHIFT } = __test;

  it('merged-opponent model: threat minimum power covers the reachable cell', () => {
    // me: 0(1); grey 1; enemy 2(6) and a third player 3(3), merged into one opponent.
    const s = lineMatch([1, 0, 6, 3], [0, NEUTRAL, 1, 2]);
    s.settings.players = ['master', 'hunter', 'hunter'];
    s.outAt = [-1, -1, -1];
    endAttack(s);
    const rng = new FastRng(1);
    const topo = new Topo(s, 0, true, rng);
    expect(Array.from(topo.players)).toEqual([0, 1, 1]);
    const b = Board.fromState(s, topo, rng, 0, null);
    // 6 walks through the grey cell (5 left) -> need min(5-1, 8) - 1 = 3, cut to the income of 1
    expect(b.minCount).toBe(1);
    expect(b.moves).toEqual([0 * SHIFT + 1]);
  });

  it('no-pass attack with forced continuation from the captured cell', () => {
    // 0(5) me, 1 grey, 2 grey, 3(1) enemy
    const s = lineMatch([5, 0, 0, 1], [0, NEUTRAL, NEUTRAL, 1]);
    const rng = new FastRng(1);
    const topo = new Topo(s, 0, true, rng);
    const b = Board.fromState(s, topo, rng, 0, null);
    expect(b.moves).toEqual([0 * SHIFT + 1]);
    b.doMove(b.moves[0]);
    expect(b.moves).toEqual([1 * SHIFT + 2]);
  });

  it('returns legal moves and is deterministic with a fixed playout budget', async () => {
    const st = sampleStates({}, [12]).filter((s) => s.phase === 'attack').slice(0, 15);
    const run = () => {
      const brain = new MasterBrain(42, { playouts: 30 });
      return st.map((s) => brain.decideAttack(s, ctx));
    };
    const a = run();
    expect(run()).toEqual(a);
    st.forEach((s, i) => a[i] && expect(checkAttack(s, a[i]!.from, a[i]!.to)).toBeNull());
  });

  it('power placement is deterministic and exact', async () => {
    const st = sampleStates({}, [13]).filter((s) => s.phase === 'power').slice(0, 10);
    const run = () => {
      const brain = new MasterBrain(42, { playouts: 30 });
      return st.map((s) => [...brain.decidePower(s, ctx)]);
    };
    const a = run();
    expect(run()).toEqual(a);
    st.forEach((s, i) => expect(isValidPlacement(s, new Map(a[i]))).toBe(true));
  });

  it('respects the time cap per decision', async () => {
    const s = createMatch({ ...base, size: 'XL', players: ['master', 'hunter', 'hunter', 'hunter'] }, { seed: 3 });
    const bot = new MasterBot({ seed: 1, sync: true, maxDecisionMs: 300, firstAttackMs: 1000, firstAttackRuns: 1e9 });
    const t0 = performance.now();
    const mv = await bot.nextAttack(s, { speedMs: 400 });
    expect(mv).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('wins a full match against Hunter', async () => {
    const r = await runMatch(
      { ...base, size: 'S', players: ['hunter', 'master'] },
      { seed: 77, bots: [new HunterBot(1), new MasterBot({ seed: 2, sync: true, playouts: 60 })], checkInvariants: true },
    );
    expect(r.winner).toBe(1);
  });
});
