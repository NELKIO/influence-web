import { describe, expect, it } from 'vitest';
import { buildScenario, SCENARIOS } from '../../src/core/scenarios';
import { isConnected } from '../../src/core/field';
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
        expect(st.ended).toBeNull();
        expect(JSON.stringify(buildScenario(id, seed * 131).field)).toBe(JSON.stringify(f));
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
