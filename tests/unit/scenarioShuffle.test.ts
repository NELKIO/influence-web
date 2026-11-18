import { describe, expect, it } from 'vitest';
import { buildScenario, SCENARIO_META, SCENARIOS, startMatch } from '../../src/core/scenarios';
import { previewBattleMatch } from '../../src/net/battleRules';
import type { MatchSettings, MatchState, PlayerType } from '../../src/core/types';

const power = (s: MatchState, seat: number) => s.field.cells.reduce((a, c) => a + (c.owner === seat ? c.power : 0), 0);
const settingsFor = (puzzle: string, players: PlayerType[], shuffle: boolean): MatchSettings => ({
  kind: 'single', size: SCENARIO_META[puzzle as 'olympus'].size, players, darkness: false, symmetry: false, crowded: false,
  unions: false, shuffle, duelRules: false, puzzle,
});

// configurable scenarios whose designs give your seat a stronger start (the difficulty knob)
const boosted = SCENARIOS.filter((id) => SCENARIO_META[id].configurable && id !== 'landing').filter((id) => {
  const m = SCENARIO_META[id];
  const st = buildScenario(id, 7, undefined, [...m.players]);
  return power(st, 0) > Math.max(...m.players.slice(1).map((_, i) => power(st, i + 1)));
});

describe('shuffled seats of a configurable scenario', () => {
  it('there are scenarios with a stronger start for you', () => {
    expect(boosted).toEqual(expect.arrayContaining(['olympus', 'archipelago']));
  });

  for (const id of boosted) {
    it(`${id}: the stronger start stays with you wherever you move in the turn order`, () => {
      const players = [...SCENARIO_META[id].players];
      const seatsOfYou = new Set<number>();
      for (let seed = 1; seed <= 12; seed++) {
        const plain = startMatch(settingsFor(id, players, false), seed);
        const st = startMatch(settingsFor(id, players, true), seed);
        const you = st.settings.players.indexOf('human');
        seatsOfYou.add(you);
        expect([...st.settings.players].sort()).toEqual([...players].sort());
        expect(power(st, you), `seed ${seed}`).toBe(power(plain, 0));
        // the same map, only the turn order differs
        expect(st.field.cells.map((c) => c.power)).toEqual(plain.field.cells.map((c) => c.power));
        expect(st.objectives).toEqual(plain.objectives);
      }
      expect(seatsOfYou.size).toBeGreaterThan(1);
    });
  }

  it('an online room gives the stronger start to the host, also in a shuffled order', () => {
    const settings = { ...settingsFor('olympus', ['human', 'online', 'online'], true), kind: 'battleOnline' as const };
    const plain = startMatch({ ...settings, shuffle: false }, 5);
    let moved = false;
    for (let seed = 1; seed <= 12; seed++) {
      const { order, state } = previewBattleMatch(settings, seed);
      const host = order.indexOf(0);
      if (host !== 0) moved = true;
      expect(power(state, host)).toBe(power(startMatch({ ...settings, shuffle: false }, seed), 0));
    }
    expect(moved).toBe(true);
    expect(plain.settings.players).toEqual(['human', 'online', 'online']);
  });
});
