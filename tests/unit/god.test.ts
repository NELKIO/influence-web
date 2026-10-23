import { describe, expect, it, vi } from 'vitest';
import { createBot } from '../../src/ai';
import { runMatch } from '../../src/ai/arena';
import { GodBot } from '../../src/ai/godBot';
import { GodBrain } from '../../src/ai/god';
import { FastRng, Sim, Topo, playTurn, DEFAULT_PARAMS } from '../../src/ai/godSim';
import { isValidPlacement } from '../../src/ai/masterBot';
import { DummyBot } from '../../src/ai/dummy';
import { HunterBot } from '../../src/ai/hunter';
import { smartyPower } from '../../src/ai/common';
import { buildScenario, SCENARIOS } from '../../src/core/scenarios';
import {
  addPower,
  alivePlayers,
  attack,
  cellCount,
  checkAttack,
  createMatch,
  endAttack,
  finishTurn,
  incomeFor,
  scoreOf,
  targetsFrom,
} from '../../src/core/engine';
import { NEUTRAL, type BotType, type MatchSettings, type MatchState, type PlayerType } from '../../src/core/types';

// slow CI runners: these tests run real searches and whole matches
vi.setConfig({ testTimeout: 60_000 });

const ctx = { speedMs: 0 };
const FAST = { sync: true, rollouts: 40 } as const;

const base: MatchSettings = {
  kind: 'single',
  size: 'M',
  players: ['god', 'hunter'],
  darkness: false,
  symmetry: false,
  crowded: false,
  unions: false,
  shuffle: false,
  duelRules: false,
};

function god(seed = 1, extra: Record<string, unknown> = {}): GodBot {
  return createBot('god', { seed, god: { ...FAST, ...extra } }) as GodBot;
}

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

/** Mid-game states of quick Hunter/Dummy matches (GOD's seat is played by a Dummy to get there). */
function sampleStates(settings: Partial<MatchSettings>, seeds: number[], maxTurn = 8): MatchState[] {
  const out: MatchState[] = [];
  for (const seed of seeds) {
    const s = createMatch({ ...base, players: ['god', 'hunter', 'dummy'], ...settings }, { seed });
    const bots = s.settings.players.map((_, i) => (i % 2 ? new HunterBot(seed + i) : new DummyBot()));
    let steps = 0;
    while (!s.ended && s.turn < maxTurn && steps++ < 600) {
      if (s.current === 0) out.push(structuredClone(s));
      const mv = bots[s.current].pickAttack(s);
      if (mv) {
        attack(s, mv.from, mv.to);
        if ((s.ended as MatchState["ended"])?.winner === -1 && alivePlayers(s).length > 1) s.ended = null;
        continue;
      }
      endAttack(s);
      if (s.current === 0) out.push(structuredClone(s));
      for (const [c, k] of smartyPower(s)) addPower(s, c, k);
      finishTurn(s);
    }
  }
  return out.filter((s) => !s.ended && s.current === 0);
}

async function checkOnStates(states: MatchState[], extra: Record<string, unknown> = {}) {
  let attacks = 0;
  let placements = 0;
  for (const st of states) {
    const snap = JSON.stringify(st);
    const bot = god(7, extra);
    if (st.phase === 'attack') {
      const mv = await bot.nextAttack(st, ctx);
      if (mv) {
        expect(checkAttack(st, mv.from, mv.to)).toBeNull();
        attacks++;
      }
    } else {
      const pl = await bot.placePower(st, ctx);
      expect(isValidPlacement(st, pl)).toBe(true);
      placements++;
    }
    expect(JSON.stringify(st)).toBe(snap); // never mutates the passed state
  }
  return { attacks, placements };
}

describe('GOD: legality, exact placements, no mutation', () => {
  it('normal rules', async () => {
    const r = await checkOnStates(sampleStates({}, [1, 2, 3]));
    expect(r.attacks).toBeGreaterThan(5);
    expect(r.placements).toBeGreaterThan(5);
  });

  it('duel rules', async () => {
    const r = await checkOnStates(sampleStates({ duelRules: true, kind: 'duelTraining', players: ['god', 'duelHunter'] }, [4, 5]));
    expect(r.placements).toBeGreaterThan(3);
  });

  it('darkness, crowded and six players', async () => {
    await checkOnStates(sampleStates({ darkness: true }, [6]));
    await checkOnStates(sampleStates({ crowded: true, size: 'S' }, [7]));
    await checkOnStates(sampleStates({ size: 'L', players: ['god', 'hunter', 'dummy', 'hunter', 'dummy', 'hunter'] }, [8], 5));
  });

  it('with a real time budget (no fixed rollouts) it respects the decision cap', async () => {
    const st = sampleStates({ size: 'XL' }, [9], 6).find((s) => s.phase === 'attack' && s.turn >= 3)!;
    const bot = createBot('god', { seed: 3, god: { sync: true, firstAttackMs: 60, attackMs: 30, maxDecisionMs: 150 } }) as GodBot;
    const t0 = performance.now();
    const mv = await bot.nextAttack(st, ctx);
    expect(performance.now() - t0).toBeLessThan(600);
    if (mv) expect(checkAttack(st, mv.from, mv.to)).toBeNull();
  });
});

describe('GOD: edge cases', () => {
  it('returns null when nothing can attack and outside its attack phase', async () => {
    const s = lineMatch([1, 1, 0, 1], [0, 0, NEUTRAL, 1]);
    expect(await god().nextAttack(s, ctx)).toBeNull();
    endAttack(s);
    expect(await god().nextAttack(s, ctx)).toBeNull();
  });

  it('a player without border cells (disconnected map) does not hang', async () => {
    const s = lineMatch([5, 5, 3, 3], [0, 0, 1, 1]);
    s.field.adj = [[1], [0], [3], [2]];
    expect(await god().nextAttack(s, ctx)).toBeNull();
    endAttack(s);
    expect(isValidPlacement(s, await god().placePower(s, ctx))).toBe(true);
  });

  it('placement respects capacities when free room is tight, zero income is empty', async () => {
    const s = lineMatch([7, 8, 7, 1], [0, 0, 0, 1]);
    endAttack(s);
    expect(s.powerLeft).toBe(2);
    const pl = await god().placePower(s, ctx);
    expect(isValidPlacement(s, pl)).toBe(true);
    const z = lineMatch([8, 8, 1], [0, 0, 1]);
    endAttack(z);
    expect(z.powerLeft).toBe(0);
    expect((await god().placePower(z, ctx)).size).toBe(0);
  });

  it('takes a sure capture that wins the match', async () => {
    const s = lineMatch([6, 1], [0, 1]);
    expect(await god().nextAttack(s, ctx)).toEqual({ from: 0, to: 1 });
  });

  it('duel rules: greys first even when an enemy cell is weaker', async () => {
    // 1 (grey) - 0 (own, 6) - 2 (enemy, 1)
    const s = lineMatch([0, 6, 1], [NEUTRAL, 0, 1], { duelRules: true, kind: 'duelTraining' });
    expect(targetsFrom(s, 1)).toEqual([0]);
    const mv = await god().nextAttack(s, ctx);
    expect(mv).toEqual({ from: 1, to: 0 });
  });

  it('is deterministic for a seed with a fixed rollout budget', async () => {
    const states = sampleStates({}, [11]).slice(0, 8);
    for (const st of states) {
      const a = god(5);
      const b = god(5);
      if (st.phase === 'attack') expect(await a.nextAttack(st, ctx)).toEqual(await b.nextAttack(st, ctx));
      else expect([...(await a.placePower(st, ctx))]).toEqual([...(await b.placePower(st, ctx))]);
    }
  });

  it('a starved time budget (slow device) still plays a move whenever an attack exists', async () => {
    const zero = { sync: true, firstAttackMs: 0, attackMs: 0, attackSpeedFactor: 0, powerMs: 0, maxDecisionMs: 0 };
    const states = [
      ...sampleStates({ players: ['god', 'hunter'] }, [31, 32]),
      ...sampleStates({ size: 'L', players: ['god', 'hunter', 'dummy'] }, [33]),
    ];
    // a clock that jumps a whole second on every read: every budget is exhausted immediately
    let t = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (t += 1000));
    try {
      let checked = 0;
      for (const st of states) {
        const bot = createBot('god', { seed: 5, god: zero });
        if (st.phase === 'attack') {
          const legal = st.field.cells.some((c, i) => c.owner === 0 && targetsFrom(st, i).length > 0);
          const mv = await bot.nextAttack(st, ctx);
          if (legal) {
            expect(mv).not.toBeNull();
            checked++;
          }
          if (mv) expect(checkAttack(st, mv.from, mv.to)).toBeNull();
        } else {
          expect(isValidPlacement(st, await bot.placePower(st, ctx))).toBe(true);
        }
      }
      expect(checked).toBeGreaterThan(5);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('never attacks forever: a whole attack phase ends', async () => {
    const st = sampleStates({ size: 'L' }, [12], 5).find((s) => s.phase === 'attack')!;
    const s = structuredClone(st);
    const bot = god(2);
    let n = 0;
    for (;;) {
      const mv = await bot.nextAttack(s, ctx);
      if (!mv) break;
      attack(s, mv.from, mv.to);
      s.ended = null;
      expect(++n).toBeLessThan(300);
    }
  });
});

describe('GOD: darkness', () => {
  it('sees the whole map by default, like the other bots (darkness changes nothing)', async () => {
    const states = sampleStates({ darkness: true, size: 'L', players: ['god', 'hunter', 'hunter'] }, [21], 6);
    let compared = 0;
    for (const st of states) {
      const clear = structuredClone(st);
      clear.settings.darkness = false;
      if (st.phase === 'attack') expect(await god(3).nextAttack(st, ctx)).toEqual(await god(3).nextAttack(clear, ctx));
      else expect([...(await god(3).placePower(st, ctx))]).toEqual([...(await god(3).placePower(clear, ctx))]);
      compared++;
    }
    expect(compared).toBeGreaterThan(4);
  });
});

/** the fair-fog brain (an explicit option for experiments): reads only what a person would see */
const FOG = { fairFog: true } as const;

describe('GOD with fairFog: fair play (no hidden information)', () => {
  /** Swap (owner, power) between cells GOD cannot see (same capacity, so the position stays valid). */
  function scrambleHidden(st: MatchState, me: number, seed: number): MatchState {
    const s = structuredClone(st);
    const { cells, adj } = s.field;
    const vis = new Uint8Array(cells.length);
    cells.forEach((c, i) => {
      if (c.owner === me) {
        vis[i] = 1;
        for (const n of adj[i]) vis[n] = 1;
      }
    });
    const rng = new FastRng(seed);
    for (const cap of [8, 12]) {
      const hidden = cells.map((_, i) => i).filter((i) => !vis[i] && cells[i].maxPower === cap);
      for (let k = hidden.length - 1; k > 0; k--) {
        const j = rng.int(k + 1);
        const a = cells[hidden[k]];
        const b = cells[hidden[j]];
        [a.owner, b.owner] = [b.owner, a.owner];
        [a.power, b.power] = [b.power, a.power];
      }
    }
    return s;
  }

  it('decisions do not change when only invisible cells change (darkness)', async () => {
    const states = sampleStates({ darkness: true, size: 'L', players: ['god', 'hunter', 'hunter'] }, [21, 22], 7);
    let compared = 0;
    let differentBoards = 0;
    for (const st of states) {
      const other = scrambleHidden(st, 0, compared + 1);
      if (JSON.stringify(other.field.cells) !== JSON.stringify(st.field.cells)) differentBoards++;
      // public HUD numbers are unchanged by the scramble
      for (let p = 0; p < 3; p++) {
        expect(cellCount(other, p)).toBe(cellCount(st, p));
        expect(scoreOf(other, p)).toBe(scoreOf(st, p));
      }
      if (st.phase === 'attack') {
        expect(await god(3, FOG).nextAttack(other, ctx)).toEqual(await god(3, FOG).nextAttack(st, ctx));
      } else {
        expect([...(await god(3, FOG).placePower(other, ctx))]).toEqual([...(await god(3, FOG).placePower(st, ctx))]);
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(6);
    expect(differentBoards).toBeGreaterThan(3);
  });

  it('a whole darkness match: a brain fed scrambled invisible cells decides exactly the same (memory, phantoms)', () => {
    for (const seed of [31, 32]) {
      const s = createMatch({ ...base, size: 'L', darkness: true, players: ['god', 'hunter'] }, { seed });
      const a = new GodBrain(9, { rollouts: 30, fairFog: true });
      const b = new GodBrain(9, { rollouts: 30, fairFog: true });
      const hunter = new HunterBot(seed);
      let decisions = 0;
      let steps = 0;
      while (!s.ended && s.turn < 10 && steps++ < 800) {
        if (s.current === 0) {
          const other = scrambleHidden(s, 0, steps);
          if (s.phase === 'attack') {
            const mv = a.decideAttack(s, ctx);
            expect(b.decideAttack(other, ctx)).toEqual(mv);
            decisions++;
            if (mv) {
              attack(s, mv.from, mv.to);
              if ((s.ended as MatchState["ended"])?.winner === -1 && alivePlayers(s).length > 1) s.ended = null;
              continue;
            }
            endAttack(s);
          } else {
            const pl = a.decidePower(s, ctx);
            expect([...b.decidePower(scrambleHidden(s, 0, steps + 1000), ctx)]).toEqual([...pl]);
            decisions++;
            for (const [c, k] of pl) addPower(s, c, k);
            finishTurn(s);
          }
          continue;
        }
        const mv = hunter.pickAttack(s);
        if (mv) {
          attack(s, mv.from, mv.to);
          if ((s.ended as MatchState["ended"])?.winner === -1 && alivePlayers(s).length > 1) s.ended = null;
          continue;
        }
        endAttack(s);
        for (const [c, k] of smartyPower(s)) addPower(s, c, k);
        finishTurn(s);
      }
      expect(decisions).toBeGreaterThan(15);
    }
  });

  it('never reads the hidden streak-corrector counters', async () => {
    for (const st of sampleStates({}, [23]).slice(0, 10)) {
      const other = structuredClone(st);
      other.luck = [3, 2, 2];
      if (st.phase === 'attack') expect(await god(4).nextAttack(other, ctx)).toEqual(await god(4).nextAttack(st, ctx));
      else expect([...(await god(4).placePower(other, ctx))]).toEqual([...(await god(4).placePower(st, ctx))]);
    }
  });
});

describe('GOD: simulator matches the engine', () => {
  it('fights, income and placements agree with the engine on random play', { timeout: 60_000 }, () => {
    for (let g = 0; g < 36; g++) {
      const duel = g % 3 === 0;
      const settings: MatchSettings = {
        ...base,
        size: (['S', 'M', 'L'] as const)[g % 3],
        players: duel ? ['hunter', 'hunter'] : ['hunter', 'master', 'dummy'],
        duelRules: duel,
        symmetry: g % 2 === 0,
      };
      // every 4th game starts from a puzzle position (armed grey cells, walls, odd line-ups)
      const s = g % 4 === 3 ? buildScenario(SCENARIOS[g % SCENARIOS.length], g) : createMatch(settings, { seed: g });
      const topo = new Topo(s);
      const sim = new Sim(topo, new FastRng(1));
      const rng = new FastRng(g + 1);
      const sync = () => {
        s.field.cells.forEach((c, i) => {
          sim.owner[i] = c.owner;
          sim.power[i] = c.power;
        });
        sim.recount();
      };
      for (let step = 0; step < 200 && !s.ended; step++) {
        sync();
        const me = s.current;
        const moves: [number, number][] = [];
        s.field.cells.forEach((c, i) => {
          if (c.owner === me) for (const t of targetsFrom(s, i)) moves.push([i, t]);
        });
        let simLegal = 0;
        for (let a = 0; a < topo.n; a++) for (let b = 0; b < topo.n; b++) if (sim.owner[a] === me && sim.legal(a, b)) simLegal++;
        expect(simLegal).toBe(moves.length);
        if (moves.length && rng.int(5) > 0) {
          const [a, b] = moves[rng.int(moves.length)];
          const ev = attack(s, a, b);
          if (typeof ev === 'string') throw new Error(ev);
          if (s.ended && alivePlayers(s).length > 1) s.ended = null;
          sim.apply(a, b, ev.win);
          s.field.cells.forEach((c, i) => {
            expect(sim.owner[i]).toBe(c.owner);
            expect(sim.power[i]).toBe(c.power);
          });
          continue;
        }
        endAttack(s);
        sync();
        expect(sim.income(me)).toBe(incomeFor(s, me));
        for (const [c, k] of smartyPower(s)) addPower(s, c, k);
        finishTurn(s);
      }
    }
  });

  it('opponent models play whole turns without breaking the rules', () => {
    const s = createMatch({ ...base, size: 'L', players: ['god', 'hunter', 'master', 'dummy', 'freak', 'human'] }, { seed: 3 });
    const topo = new Topo(s);
    const sim = new Sim(topo, new FastRng(9));
    s.field.cells.forEach((c, i) => {
      sim.owner[i] = c.owner;
      sim.power[i] = c.owner < 0 ? 0 : c.power;
    });
    sim.recount();
    for (let r = 0; r < 15; r++) {
      for (let p = 0; p < 6; p++) playTurn(sim, p, DEFAULT_PARAMS);
      for (let i = 0; i < topo.n; i++) {
        if (sim.owner[i] < 0) expect(sim.power[i]).toBe(0);
        else {
          expect(sim.power[i]).toBeGreaterThanOrEqual(1);
          expect(sim.power[i]).toBeLessThanOrEqual(topo.cap[i]);
        }
      }
    }
  });
});

describe('GOD: whole matches', () => {
  it('six-player match (GOD + 5 Hunters) with invariants checked', async () => {
    const players: PlayerType[] = ['hunter', 'god', 'hunter', 'hunter', 'hunter', 'hunter'];
    const settings: MatchSettings = { ...base, size: 'L', players };
    const bots = players.map((p, i) => createBot(p as BotType, { seed: 40 + i, god: FAST }));
    const r = await runMatch(settings, { seed: 41, bots, maxRounds: 120, checkInvariants: true });
    expect(r.rounds).toBeLessThanOrEqual(120);
  }, 30_000);

  it('duel rules and darkness matches run to the end', async () => {
    const duel: MatchSettings = { ...base, kind: 'duelTraining', players: ['god', 'duelHunter'], duelRules: true };
    const r1 = await runMatch(duel, { seed: 5, bots: [god(1), createBot('duelHunter', { seed: 2 })], maxRounds: 150, checkInvariants: true });
    expect(r1.winner).toBe(0);
    const dark: MatchSettings = { ...base, size: 'L', darkness: true, players: ['hunter', 'god', 'master'] };
    const bots = dark.players.map((p, i) => createBot(p as BotType, { seed: 9 + i, god: FAST, master: { sync: true, playouts: 20 } }));
    const r2 = await runMatch(dark, { seed: 6, bots, maxRounds: 150, checkInvariants: true });
    expect(r2.rounds).toBeLessThanOrEqual(150);
  }, 30_000);

  it('puzzle scenarios play without errors with GOD in every bot seat', async () => {
    for (const id of SCENARIOS.slice(0, 8)) {
      const state = buildScenario(id, 77);
      const bots = state.settings.players.map((p, slot) =>
        createBot(slot === 0 || p === 'master' ? 'god' : (p as BotType), { seed: slot + 1, god: { sync: true, rollouts: 15 } }),
      );
      // (puzzle positions may start with armed grey cells, which the arena invariants reject)
      const r = await runMatch(state.settings, { seed: 77, bots, state, maxRounds: 40 });
      expect(r.rounds).toBeLessThanOrEqual(40);
    }
  }, 60_000);

  it('the brain can be used directly and reports its effort', () => {
    const s = createMatch({ ...base, size: 'L' }, { seed: 4 });
    const b = new GodBrain(1, { rollouts: 50 });
    const mv = b.decideAttack(s, ctx);
    expect(mv && checkAttack(s, mv.from, mv.to)).toBeNull();
    expect(b.lastInfo.rollouts).toBeGreaterThan(0);
  });
});
