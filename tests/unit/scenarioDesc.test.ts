import { describe, expect, it } from 'vitest';
import { setLang } from '../../src/i18n';
import { ru } from '../../src/i18n/ru';
import { scenarioDesc } from '../../src/ui/components/ScenarioInfo';

describe('scenario description shown for a match', () => {
  it('a map of the day that kept its older design shows its own old text', () => {
    setLang('ru');
    expect(scenarioDesc('sparks', true)).toBe(ru.puzzleDescDaily_sparks);
    expect(scenarioDesc('sparks', false)).toBe(ru.puzzleDesc_sparks);
    expect(scenarioDesc('olympus', true)).toBe(ru.puzzleDescDaily_olympus);
  });

  it('other scenarios read the same on the day and in the gallery', () => {
    setLang('ru');
    expect(scenarioDesc('siege', true)).toBe(ru.puzzleDesc_siege);
    expect(scenarioDesc('siege', false)).toBe(ru.puzzleDesc_siege);
  });
});
