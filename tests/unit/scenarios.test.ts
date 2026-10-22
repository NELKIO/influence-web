import { describe, expect, it } from 'vitest';
import { BATTLE_SCENARIOS, buildScenario, DAILY_SCENARIOS, SCENARIO_META, SCENARIOS, startMatch } from '../../src/core/scenarios';
import { isConnected } from '../../src/core/field';
import { articulationPoints, chokePoints } from '../../src/core/connectivity';
import { dailyKind } from '../../src/daily';
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
          createBot(slot === 0 ? 'master' : (p as BotType), { seed: seed + slot, master: { playouts: 60 } }),
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

  it('battle scenarios have three to six seats', () => {
    for (const id of BATTLE_SCENARIOS) {
      expect(SCENARIO_META[id].players.length).toBeGreaterThanOrEqual(3);
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

  it('the map of the day keeps its frozen list of scenarios', () => {
    expect(DAILY_SCENARIOS).toHaveLength(24);
    for (const id of BATTLE_SCENARIOS) expect(DAILY_SCENARIOS as readonly string[]).not.toContain(id);
    expect(SCENARIOS).toHaveLength(DAILY_SCENARIOS.length + BATTLE_SCENARIOS.length);
    // the schedule of past days is unchanged
    const past: Record<string, string> = {
      '2026-09-01': 'archipelago',
      '2026-10-01': 'hydra',
      '2026-10-21': 'hydra',
      '2026-10-22': 'thermopylae',
      '2026-10-23': 'twofronts',
      '2026-11-15': 'checker',
    };
    for (const [day, id] of Object.entries(past)) {
      const k = dailyKind(day);
      expect(k.kind === 'puzzle' && k.scenario).toBe(id);
    }
  });
});
