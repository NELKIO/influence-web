import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../src/i18n';
import { DAILY_LEGACY_DESC, SCENARIOS } from '../../src/core/scenarios';
import { scenarioBrief, scenarioDesc } from '../../src/ui/components/ScenarioInfo';

// the hint at the start of a match is read in a few seconds over the board: it stays short
const LIMIT = { ru: 125, en: 125 } as const;

describe('the scenario hint at the start of a match', () => {
  afterEach(() => setLang('ru'));

  for (const lang of ['ru', 'en'] as const) it(`fits a quick read for every scenario (${lang})`, () => {
    setLang(lang);
    for (const id of SCENARIOS) {
      expect(scenarioBrief(id, false).length, id).toBeLessThanOrEqual(LIMIT[lang]);
      expect(scenarioBrief(id, false), id).not.toBe('');
    }
  });

  it('a map of the day built by an older design keeps that design’s own text', () => {
    for (const id of DAILY_LEGACY_DESC) expect(scenarioBrief(id, true)).toBe(scenarioDesc(id, true));
  });
});
