/**
 * Scenarios where every seat starts on equal terms: against bots your seat may start a little stronger
 * (the difficulty knob), but when several people play, nobody's start is better than another's.
 */
import { describe, expect, it } from 'vitest';
import { buildScenario, SCENARIO_META, scenarioSetup, startMatch, type ScenarioId } from '../../src/core/scenarios';
import type { PlayerType } from '../../src/core/types';

const EQUAL: ScenarioId[] = ['olympus', 'moonvale', 'highlands', 'crossroads', 'colonies', 'fireflies', 'archipelago', 'landing', 'sparks'];

/** Per seat: the powers of its start cells, sorted. */
const starts = (id: ScenarioId, seed: number, players: PlayerType[]) => {
  const st = buildScenario(id, seed, undefined, players);
  return players.map((_, p) => st.field.cells.filter((c) => c.owner === p).map((c) => c.power).sort((a, b) => a - b));
};

describe('people at the table start alike', () => {
  for (const id of EQUAL) {
    const m = SCENARIO_META[id];
    const [min, max] = m.configurable?.seats ?? [m.players.length, m.players.length];
    it(`${id}: with two or more people every seat starts with the same cells and power`, () => {
      for (let n = min; n <= max; n++) {
        for (const seed of [3, 17, 40]) {
          const people: PlayerType[] = ['human', 'online', ...Array<PlayerType>(n - 2).fill('master')];
          const per = starts(id, seed, people);
          for (const seat of per) expect(seat, `${id}, ${n} seats, seed ${seed}`).toEqual(per[1]);
        }
      }
    });
  }

  it('fireflies against bots keeps your slightly stronger scout; with friends nobody has one', () => {
    const alone = starts('fireflies', 5, ['human', 'hunter', 'hunter']);
    expect(alone[0].reduce((a, b) => a + b)).toBeGreaterThan(alone[1].reduce((a, b) => a + b));
    const friends = starts('fireflies', 5, ['human', 'human', 'online']);
    expect(friends).toEqual([[2, 2, 2], [2, 2, 2], [2, 2, 2]]);
  });

  it('the map is the same; only the start powers change', () => {
    const size = scenarioSetup('moonvale').size;
    const a = startMatch({ kind: 'single', size, players: ['human', 'master', 'hunter'], darkness: true, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false, puzzle: 'moonvale' }, 8);
    const b = startMatch({ ...a.settings, players: ['human', 'online', 'hunter'], kind: 'battleOnline' }, 8);
    expect(b.field.cells.map((c) => [c.owner, c.maxPower])).toEqual(a.field.cells.map((c) => [c.owner, c.maxPower]));
  });
});
