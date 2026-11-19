import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../src/i18n';
import { SCENARIOS } from '../../src/core/scenarios';
import { ROTATION } from '../../src/daily';
import { scenarioBrief } from '../../src/ui/components/ScenarioInfo';

// the hint at the start of a match is read in a few seconds over the board: it stays short
const LIMIT = { ru: 125, en: 125 } as const;

describe('the scenario hint at the start of a match', () => {
  afterEach(() => setLang('ru'));

  for (const lang of ['ru', 'en'] as const) it(`fits a quick read for every scenario (${lang})`, () => {
    setLang(lang);
    // the gallery and the map of the day
    for (const id of new Set([...SCENARIOS, ...ROTATION])) {
      expect(scenarioBrief(id).length, id).toBeLessThanOrEqual(LIMIT[lang]);
      expect(scenarioBrief(id), id).not.toBe('');
    }
  });
});
