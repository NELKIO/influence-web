import { describe, expect, it } from 'vitest';
import { BATTLE_SCENARIOS, buildScenario, SCENARIO_META, SCENARIOS, startMatch } from '../../src/core/scenarios';
import { isConnected } from '../../src/core/field';
import { articulationPoints, chokePoints } from '../../src/core/connectivity';
import { createDailyMatch, dailyKind, dailyLevel, dailySeed, dayId, ROTATION } from '../../src/daily';
import { runMatch } from '../../src/ai/arena';
import { createBot } from '../../src/ai';
import type { BotType } from '../../src/core/types';

describe('puzzle scenarios', () => {
  for (const id of SCENARIOS) {
    it(`${id}: valid, reproducible positions`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const st = buildScenario(id, seed * 131);
        const f = st.field;
        expect(isConnected(f)).toBe(true);
        expect(f.cells.length).toBeGreaterThan(30);
        st.settings.players.forEach((_, slot) => expect(f.cells.some((c) => c.owner === slot)).toBe(true));
        for (const c of f.cells) {
          expect(c.power).toBeGreaterThanOrEqual(0);
          expect(c.power).toBeLessThanOrEqual(c.maxPower);
        }
        // adjacency is symmetric and walls only separate neighbours
        f.adj.forEach((ns, i) => ns.forEach((j) => expect(f.adj[j]).toContain(i)));
        expect(st.settings.puzzle).toBe(id);
        expect(st.settings.players).toEqual(SCENARIO_META[id].players);
        expect(st.settings.darkness).toBe(!!SCENARIO_META[id].darkness);
        expect(st.settings.unions).toBe(!!SCENARIO_META[id].unions);
        expect(st.ended).toBeNull();
        expect(JSON.stringify(buildScenario(id, seed * 131).field)).toBe(JSON.stringify(f));
      }
    });

    it(`${id}: no single cell cuts the players apart`, () => {
      for (let seed = 1; seed <= 30; seed++) {
        const f = buildScenario(id, seed * 977).field;
        // every owned cell counts as a start, so the check does not depend on which cell stands for a player
        const owned = f.cells.flatMap((c, i) => (c.owner >= 0 ? [i] : []));
        expect(chokePoints(f.adj, owned), `seed ${seed * 977}`).toEqual([]);
      }
    });

    it(`${id}: can be won by a strong player`, async () => {
      let wins = 0;
      for (let i = 0; i < 4 && wins === 0; i++) {
        const seed = 500 + i * 37;
        const state = buildScenario(id, seed);
        const bots = state.settings.players.map((p, slot) =>
          createBot(slot === 0 ? 'master' : (p as BotType), { seed: seed + slot, master: { playouts: 60 }, god: { sync: true, rollouts: 40 } }),
        );
        const res = await runMatch(state.settings, { seed, bots, state, maxRounds: 120 });
        if (res.winner === 0 || res.state.ended?.humanWon) wins++;
      }
      expect(wins).toBeGreaterThan(0);
    }, 60_000);
  }
});

describe('scenarios as battle presets', () => {
  it('any seat types for the scenario seats; the map does not depend on them', () => {
    const base = buildScenario('olympus', 42);
    const custom = buildScenario('olympus', 42, undefined, ['human', 'god', 'human', 'online', 'master', 'dummy']);
    expect(custom.settings.players).toEqual(['human', 'god', 'human', 'online', 'master', 'dummy']);
    expect(JSON.stringify(custom.field)).toBe(JSON.stringify(base.field));
    expect(() => buildScenario('olympus', 42, undefined, ['human', 'hunter'])).toThrow();
  });

  it('startMatch builds the scenario named in the settings, keeping the kind of match', () => {
    const st = startMatch({ ...buildScenario('titans', 1).settings, kind: 'battleOnline', players: ['human', 'online', 'master'] }, 9);
    expect(st.settings.kind).toBe('battleOnline');
    expect(st.settings.puzzle).toBe('titans');
    expect(st.settings.unions).toBe(true);
    expect(JSON.stringify(st.field)).toBe(JSON.stringify(buildScenario('titans', 9).field));
  });

  it('recommended opponents are Hunters at least, mostly Masters, at most one GOD', () => {
    const all = SCENARIOS.flatMap((id) => {
      const bots = SCENARIO_META[id].players.slice(1);
      for (const b of bots) expect(['hunter', 'master', 'god']).toContain(b);
      expect(bots.filter((b) => b === 'god').length).toBeLessThanOrEqual(1);
      return bots;
    });
    expect(all.filter((b) => b === 'master' || b === 'god').length).toBeGreaterThan(all.length * 0.6);
  });

  it('the later scenarios are battles for three to six seats, and the raid duel', () => {
    for (const id of BATTLE_SCENARIOS) {
      expect(SCENARIO_META[id].players.length).toBeGreaterThanOrEqual(id === 'raid' ? 2 : 3);
      expect(SCENARIO_META[id].players[0]).toBe('human');
    }
  });

  it('night drop: a big dark map with no cut cells at all, everybody dropped somewhere new each game', () => {
    const spots = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const st = buildScenario('landing', seed * 7);
      expect(st.settings.darkness).toBe(true);
      expect(st.settings.players).toHaveLength(6);
      expect(st.field.cells.length).toBeGreaterThan(150);
      expect(articulationPoints(st.field.adj)).toEqual([]);
      const mine = st.field.cells.findIndex((c) => c.owner === 0);
      const c = st.field.cells[mine];
      spots.add(c.y * 100 + c.x);
      // drops are spread out: no two players start next to each other
      for (let p = 0; p < 6; p++)
        for (const i of st.field.cells.flatMap((x, j) => (x.owner === p ? [j] : [])))
          for (const n of st.field.adj[i]) expect([-1, p]).toContain(st.field.cells[n].owner);
    }
    expect(spots.size).toBeGreaterThan(8);
  });

  it('hollow lands: four equal realms of empty cells, 1s only along the borders, nothing neutral but the centre', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const st = buildScenario('hollow', seed * 31, 0);
      const { cells, adj } = st.field;
      expect(st.settings.players).toHaveLength(4);
      const sizes = [0, 1, 2, 3].map((p) => cells.filter((c) => c.owner === p).length);
      expect(new Set(sizes).size).toBe(1);
      expect(cells.filter((c) => c.owner < 0)).toHaveLength(1);
      cells.forEach((c, i) => {
        if (c.owner < 0) return;
        const border = adj[i].some((j) => cells[j].owner >= 0 && cells[j].owner !== c.owner);
        expect(c.power).toBe(border ? 1 : 0);
      });
      for (const p of [0, 1, 2, 3]) {
        const own = cells.filter((c) => c.owner === p);
        expect(own.filter((c) => c.power === 0).length).toBeGreaterThan(own.length / 2);
      }
    }
    // the knob adds 1s to your empty land (or empties your front when below 0)
    const more = buildScenario('hollow', 31, 10).field.cells.filter((c) => c.owner === 0);
    const less = buildScenario('hollow', 31, -4).field.cells.filter((c) => c.owner === 0);
    const base = buildScenario('hollow', 31, 0).field.cells.filter((c) => c.owner === 0);
    const sum = (l: { power: number }[]) => l.reduce((n, c) => n + c.power, 0);
    expect(sum(more)).toBe(sum(base) + 10);
    expect(sum(less)).toBe(sum(base) - 4);
  });

  it('between titans: vast empires, empty behind a strong front; your realm is full', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { cells } = buildScenario('titans', seed * 17).field;
      for (const p of [1, 2]) {
        const own = cells.filter((c) => c.owner === p);
        expect(own.length).toBeGreaterThan(35);
        expect(own.filter((c) => c.power === 0).length).toBeGreaterThan(own.length / 2);
        expect(own.some((c) => c.power >= 4)).toBe(true);
      }
      const mine = cells.filter((c) => c.owner === 0);
      expect(mine.length).toBeLessThan(10);
      for (const c of mine) expect(c.power).toBeGreaterThanOrEqual(Math.min(c.maxPower, 6));
    }
  });

  it('the map of the day rotates through every scenario, played as the setup recommends it', () => {
    // from the latest switch on (Oct 24, a battle day), one stretch of puzzle days covers each scenario
    expect(ROTATION).toContain('raid');
    expect(ROTATION).not.toContain('hollow');
    const seen: string[] = [];
    for (let i = 0; seen.length < ROTATION.length; i++) {
      const id = dayId(new Date(2026, 9, 24 + i));
      const k = dailyKind(id);
      if (k.kind !== 'puzzle') continue;
      seen.push(k.scenario);
      const m = createDailyMatch(id);
      expect(m.settings.kind).toBe('daily');
      expect(m.settings.players).toEqual(SCENARIO_META[k.scenario].players);
      expect(dailyLevel(id)).toBe(SCENARIO_META[k.scenario].level);
      expect(JSON.stringify(m.field)).toBe(JSON.stringify(buildScenario(k.scenario, dailySeed(id)).field));
    }
    expect(new Set(seen).size).toBe(ROTATION.length);
    // past days keep the scenario people played (the classic rotation); the switch brings a new one
    const days: Record<string, string> = {
      '2026-09-01': 'archipelago',
      '2026-10-01': 'hydra',
      '2026-10-21': 'hydra',
      '2026-10-22': 'thermopylae',
      '2026-10-23': 'olympus',
      '2026-10-24': 'battle',
      '2026-10-25': 'overload',
      '2026-10-29': 'raid',
    };
    for (const [day, id] of Object.entries(days)) {
      const k = dailyKind(day);
      expect(k.kind === 'puzzle' ? k.scenario : 'battle').toBe(id);
    }
  });

  it('a scenario of the day does not come back within eight puzzle days, also across both switches and cycles', () => {
    const recent: string[] = [];
    for (let d = 0; d < 3 * 365; d++) {
      const id = dayId(new Date(2026, 9, 10 + d));
      const k = dailyKind(id);
      if (k.kind !== 'puzzle') continue;
      if (id >= '2026-10-23') expect(recent.slice(-8), id).not.toContain(k.scenario);
      recent.push(k.scenario);
    }
  });

  it('the night drop of the day is the same for everyone', () => {
    let day = '';
    for (let i = 0; !day; i++) {
      const id = dayId(new Date(2026, 9, 21 + i));
      const k = dailyKind(id);
      if (k.kind === 'puzzle' && k.scenario === 'landing') day = id;
    }
    const a = createDailyMatch(day);
    const b = createDailyMatch(day);
    expect(a.settings.blind).toBe(true);
    expect(JSON.stringify(a.field)).toBe(JSON.stringify(b.field));
    expect(a.explored).toEqual(b.explored);
  });
});
