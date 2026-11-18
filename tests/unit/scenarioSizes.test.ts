/** Every scenario of the changing-map block offers three sizes: small, medium and large. */
import { describe, expect, it } from 'vitest';
import { buildScenario, SCENARIO_META, SCENARIOS } from '../../src/core/scenarios';
import { scenarioSizeName } from '../../src/ui/components/ScenarioInfo';
import { setLang } from '../../src/i18n';

const varied = SCENARIOS.filter((id) => SCENARIO_META[id].varied);

describe('scenario sizes', () => {
  it('the whole block has three sizes, the default among them', () => {
    expect(varied).toEqual(expect.arrayContaining(['landing', 'olympus', 'moonvale', 'sparks', 'fireflies', 'crossroads', 'highlands', 'colonies']));
    for (const id of varied) {
      const c = SCENARIO_META[id].configurable;
      expect(c?.sizes, id).toHaveLength(3);
      expect(c!.sizes, id).toContain(SCENARIO_META[id].size);
    }
  });

  it('they are called small, medium and large, whatever the field size behind them', () => {
    setLang('ru');
    expect(['L', 'XL', 'XXL'].map((s) => scenarioSizeName('moonvale', s as 'L'))).toEqual(['Маленькая', 'Средняя', 'Большая']);
    expect(['M', 'L', 'XL'].map((s) => scenarioSizeName('sparks', s as 'L'))).toEqual(['Маленькая', 'Средняя', 'Большая']);
    setLang('en');
    expect(['L', 'XL', 'XXL'].map((s) => scenarioSizeName('olympus', s as 'L'))).toEqual(['Small', 'Medium', 'Large']);
  });

  // whatever the land's shape, a bigger size is never smaller: the smallest of one size beats the
  // biggest of the size before it, at the fewest and the most seats
  for (const id of varied) it(`${id}: every map of a size is bigger than every map of the size before`, () => {
    const { sizes, seats } = SCENARIO_META[id].configurable!;
    for (const n of new Set(seats)) {
      const players = Array.from({ length: n }, (_, i) => SCENARIO_META[id].players[i] ?? 'hunter');
      const ranges = sizes.map((size) => {
        const cells: number[] = [];
        for (let seed = 1; seed <= 12; seed++) cells.push(buildScenario(id, seed, undefined, players, { size }).field.cells.length);
        return [Math.min(...cells), Math.max(...cells)];
      });
      for (let g = 1; g < ranges.length; g++) expect(ranges[g][0], `${id}, ${n} seats: ${JSON.stringify(ranges)}`).toBeGreaterThan(ranges[g - 1][1]);
    }
  }, 60000);
});
