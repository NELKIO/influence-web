import { beforeEach, describe, expect, it } from 'vitest';
import { loadSetup, saveSetup, setupPlayers, setupToSettings, DEFAULT_SETUP } from '../../src/storage';
import { SCENARIO_META, startMatch } from '../../src/core/scenarios';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

describe('setup with a scenario', () => {
  it('fixes the map, seats and modes; seat types are the chosen ones or the recommended ones', () => {
    saveSetup({ ...DEFAULT_SETUP, scenario: 'landing', scenarioSeats: { titans: ['human', 'master', 'god'] } });
    let s = loadSetup();
    expect(setupPlayers(s)).toEqual(SCENARIO_META.landing.players);
    const settings = setupToSettings(s);
    expect(settings).toMatchObject({ puzzle: 'landing', size: 'XL', darkness: true, symmetry: false, shuffle: false });
    const st = startMatch(settings, 5);
    expect(st.settings.puzzle).toBe('landing');
    expect(st.field.cells.length).toBeGreaterThan(150);

    saveSetup({ ...s, scenario: 'titans' });
    s = loadSetup();
    expect(setupPlayers(s)).toEqual(['human', 'master', 'god']);
    expect(setupToSettings(s).unions).toBe(true);
  });

  it('drops unknown scenarios and seat lists that do not fit', () => {
    mem.set(
      'infweb.setup',
      JSON.stringify({ ...DEFAULT_SETUP, scenario: 'nope', scenarioSeats: { titans: ['human', 'hunter'], olympus: ['dummy', 'a', 'b', 'c', 'd', 'e'] } }),
    );
    const s = loadSetup();
    expect(s.scenario).toBeNull();
    expect(s.scenarioSeats).toEqual({});
    // an old setup without the new fields still loads as an ordinary battle
    mem.set('infweb.setup', JSON.stringify({ size: 'S', players: ['human', 'hunter'] }));
    const old = loadSetup();
    expect(old.scenario).toBeNull();
    expect(setupToSettings(old).puzzle).toBeUndefined();
    expect(startMatch(setupToSettings(old), 3).settings.size).toBe('S');
  });
});
