import { describe, expect, it } from 'vitest';
import { createBot } from '../../src/ai';
import { runMatch } from '../../src/ai/arena';
import { autoPower, createMatch, defaultOrderComp, endAttack, finishTurn, roundOrder, seatBonus } from '../../src/core/engine';
import { buildScenario, SCENARIOS, startMatch } from '../../src/core/scenarios';
import { seatsMedal } from '../../src/medals';
import { createDailyMatch, dailyKind, dailySettings, dayId } from '../../src/daily';
import type { FieldSize, MatchSettings, OrderComp, PlayerType } from '../../src/core/types';

const base: MatchSettings = {
  kind: 'single',
  size: 'M',
  players: ['human', 'hunter'],
  darkness: false,
  symmetry: false,
  crowded: false,
  unions: false,
  shuffle: false,
  duelRules: false,
};

const seats = (n: number): PlayerType[] => ['human', ...Array<PlayerType>(n - 1).fill('hunter')];

/** Each seat's reinforcement in its first `rounds` turns when nobody attacks. */
function incomes(settings: MatchSettings, rounds = 2, seed = 5): number[][] {
  const st = createMatch(settings, { seed });
  const n = settings.players.length;
  const out = Array.from({ length: n }, () => [] as number[]);
  for (let t = 0; t < rounds * n; t++) {
    endAttack(st);
    out[st.current].push(st.powerLeft);
    autoPower(st);
    finishTurn(st);
  }
  return out;
}

describe('turn-order compensation: the table', () => {
  it('a later seat gets more power with its first reinforcement, at most 3 per start cell', () => {
    const table = (n: number, cells = 1) => Array.from({ length: n }, (_, k) => seatBonus(k, n, cells));
    expect(table(2)).toEqual([0, 0]);
    expect(table(3)).toEqual([0, 1, 2]);
    expect(table(4)).toEqual([0, 1, 2, 3]);
    expect(table(5)).toEqual([0, 1, 2, 2, 3]);
    expect(table(6)).toEqual([0, 1, 1, 2, 2, 3]);
    expect(table(4, 3)).toEqual([0, 3, 6, 9]);
    expect(table(3, 3)).toEqual([0, 3, 6]);
    expect(table(5, 3)).toEqual([0, 2, 5, 7, 9]);
    expect(table(6, 3)).toEqual([0, 2, 4, 5, 7, 9]);
    expect(defaultOrderComp(2)).toBeNull();
    expect(defaultOrderComp(4)).toEqual({ bonus: [0, 1, 2, 3] });
  });
});

describe('turn-order compensation in ordinary battles', () => {
  for (const n of [3, 4, 5, 6]) {
    for (const size of ['M', 'L', 'XL'] as FieldSize[]) {
      it(`${n} seats on ${size}: everyone starts with 2, seat k gets its bonus once, in round 0`, () => {
        for (const symmetry of [false, true]) {
          const settings = { ...base, size, symmetry, players: seats(n) };
          const st = createMatch(settings, { seed: 11 });
          expect(st.field.cells.filter((c) => c.owner >= 0).map((c) => c.power)).toEqual(Array(n).fill(2));
          expect(st.settings.orderComp).toEqual(defaultOrderComp(n));
          // one start cell = 1 point of income, plus the bonus in round 0 only
          const inc = incomes(settings, 2);
          inc.forEach((byRound, k) => {
            expect(byRound[0]).toBe(1 + seatBonus(k, n));
            expect(byRound[1]).toBe(1);
          });
        }
      });
    }
  }

  it('two seats keep 5 and 7 (2 and 3 on S) and get no bonus, in battles and duels', () => {
    for (const size of ['S', 'M', 'L', 'XL'] as FieldSize[])
      for (const duelRules of [false, true]) {
        const st = createMatch({ ...base, size, duelRules }, { seed: 4 });
        const start = [0, 1].map((p) => st.field.cells.find((c) => c.owner === p)!.power);
        expect(start).toEqual(size === 'S' ? [2, 3] : [5, 7]);
        expect(st.settings.orderComp).toBeUndefined();
        expect(incomes({ ...base, size, duelRules }, 1, 4).map((r) => r[0])).toEqual([1, 1]);
      }
  });

  it("'off' plays as before: no bonus, and the same map as with the bonus", () => {
    const players = seats(5);
    const off = createMatch({ ...base, players, orderComp: 'off' }, { seed: 21 });
    const on = createMatch({ ...base, players }, { seed: 21 });
    expect(off.settings.orderComp).toBe('off');
    expect(JSON.stringify(off.field)).toBe(JSON.stringify(on.field));
    expect(incomes({ ...base, players, orderComp: 'off' }, 1, 21).map((r) => r[0])).toEqual([1, 1, 1, 1, 1]);
  });

  it('shuffled seats: the bonus goes by the seat (the order of moving), whoever sits there', () => {
    const players: PlayerType[] = ['human', 'master', 'hunter', 'dummy'];
    for (let seed = 1; seed <= 10; seed++) {
      const inc = incomes({ ...base, players, shuffle: true }, 1, seed);
      expect(inc.map((r) => r[0])).toEqual([1, 2, 3, 4]);
    }
  });

  it('crowded maps get the bonus too (on top of the many cells)', () => {
    const st = createMatch({ ...base, crowded: true, players: seats(4) }, { seed: 2 });
    expect(st.settings.orderComp).toEqual(defaultOrderComp(4));
    expect(st.field.cells.every((c) => c.owner >= 0 && c.power === 2)).toBe(true);
  });

  it('the other options of the compensation (kept for the measurements) do what they say', () => {
    const players = seats(4);
    const comp: OrderComp = { power: [2, 3, 4, 5], extra: [0, 0, 1, 2], grey: [1] };
    const st = createMatch({ ...base, players, orderComp: comp }, { seed: 8 });
    const own = (p: number) => st.field.cells.filter((c) => c.owner === p);
    expect(own(0).map((c) => c.power)).toEqual([2]);
    expect(own(2)).toHaveLength(2);
    expect(own(3)).toHaveLength(3);
    const start0 = st.field.cells.findIndex((c) => c.owner === 0);
    expect(st.field.adj[start0].filter((u) => st.field.cells[u].owner < 0).every((u) => st.field.cells[u].power === 1)).toBe(true);
    // round order variants
    expect(roundOrder({ ...base, players, orderComp: { order: 'rotate' } }, 1)).toEqual([1, 2, 3, 0]);
    expect(roundOrder({ ...base, players, orderComp: { order: 'snake' } }, 1)).toEqual([3, 2, 1, 0]);
    expect(roundOrder({ ...base, players }, 1)).toEqual([0, 1, 2, 3]);
  });

  it('scenarios keep their own seats (only the night drop is compensated)', () => {
    for (const id of SCENARIOS) {
      const st = buildScenario(id, 3);
      if (id === 'landing') expect(st.settings.orderComp).toEqual(defaultOrderComp(st.settings.players.length, 3));
      else expect(st.settings.orderComp).toBeUndefined();
    }
  });
});

describe('turn-order compensation in the night drop', () => {
  it('every squad starts with 3 per cell, yours too; a later seat gets 3 per squad cell and seat', () => {
    for (const n of [3, 4, 6]) {
      const players = seats(n);
      const st = buildScenario('landing', 17, 6, players, { size: 'XL' });
      for (let p = 0; p < n; p++) {
        const squad = st.field.cells.filter((c) => c.owner === p);
        expect(squad).toHaveLength(3);
        for (const c of squad) expect(c.power).toBe(Math.min(c.maxPower, 3));
      }
      const st2 = buildScenario('landing', 17, 6, players, { size: 'XL' });
      for (let k = 0; k < n; k++) {
        endAttack(st2);
        expect(st2.powerLeft).toBe(3 + seatBonus(k, n, 3));
        autoPower(st2);
        finishTurn(st2);
      }
    }
  });

  it("'off' builds the night drop as before: same land, spots in the order they were picked, no bonus", () => {
    let moved = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const off = buildScenario('landing', seed, undefined, undefined, { orderComp: 'off' });
      const on = buildScenario('landing', seed);
      expect(off.settings.orderComp).toBeUndefined();
      // the land, lakes and walls are the same; who lands where (and how the squad is turned) may differ
      expect(off.field.cells.map((c) => [c.x, c.y, c.maxPower])).toEqual(on.field.cells.map((c) => [c.x, c.y, c.maxPower]));
      expect(off.field.walls).toEqual(on.field.walls);
      if (off.field.cells.some((c, i) => c.owner !== on.field.cells[i].owner)) moved++;
    }
    expect(moved).toBeGreaterThan(10);
  });
});

describe('turn-order compensation and the map of the day', () => {
  const days = (from: string, count: number) => Array.from({ length: count }, (_, i) => dayId(new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8)) + i)));

  it('every day, past ones too, plays with the compensation; the scenario of a day is unchanged', () => {
    for (const id of days('2026-10-01', 60)) {
      const k = dailyKind(id);
      const st = createDailyMatch(id);
      if (k.kind === 'battle') {
        expect(dailySettings(id).orderComp, id).toBeUndefined();
        expect(st.settings.orderComp ?? null).toEqual(defaultOrderComp(st.settings.players.length));
      } else if (k.scenario === 'landing') {
        expect(st.settings.orderComp, id).toEqual(defaultOrderComp(st.settings.players.length, 3));
      } else expect(st.settings.orderComp, id).toBeUndefined();
    }
  });
});

describe('turn-order compensation: simulation', () => {
  it('with Hunter in every seat of a 4-player battle, seat 0 no longer dominates', async () => {
    const wins = { off: [0, 0, 0, 0], on: [0, 0, 0, 0] };
    const G = 160;
    for (const mode of ['off', 'on'] as const)
      for (let g = 0; g < G; g++) {
        const settings: MatchSettings = {
          ...base,
          size: 'M',
          symmetry: g % 2 === 0,
          players: ['hunter', 'hunter', 'hunter', 'hunter'],
          ...(mode === 'off' ? { orderComp: 'off' as const } : {}),
        };
        const bots = settings.players.map((_, i) => createBot('hunter', { seed: g * 10 + i }));
        const r = await runMatch(settings, { seed: 900 + g, bots, maxRounds: 200 });
        if (r.winner >= 0) wins[mode][r.winner]++;
      }
    const share = (w: number[]) => w.map((x) => x / G);
    // without the compensation the first mover wins about half of these games
    expect(share(wins.off)[0]).toBeGreaterThan(0.37);
    // with it every seat wins a fair share, give or take
    for (const s of share(wins.on)) {
      expect(s).toBeGreaterThan(0.16);
      expect(s).toBeLessThan(0.34);
    }
  });
});

describe('night drop: equal seats and shuffling', () => {
  it('"shuffle players" decides who moves first; the person may sit anywhere and still earns a medal', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const st = startMatch(
        { kind: 'single', size: 'XL', players: ['human', 'god', 'master', 'master'], darkness: true, symmetry: false, crowded: false, unions: false, shuffle: true, duelRules: false, puzzle: 'landing', blind: true },
        seed,
      );
      const me = st.settings.players.indexOf('human');
      seen.add(me);
      expect([...st.settings.players].sort()).toEqual(['god', 'human', 'master', 'master']);
      expect(seatsMedal('landing', st.settings.players)).toBe('medal');
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('without shuffle the seats stay as chosen', () => {
    const st = startMatch(
      { kind: 'single', size: 'XL', players: ['human', 'god', 'master'], darkness: true, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false, puzzle: 'landing', blind: true },
      5,
    );
    expect(st.settings.players).toEqual(['human', 'god', 'master']);
  });
});
