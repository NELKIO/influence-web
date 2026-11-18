import { beforeEach, describe, expect, it } from 'vitest';
import { loadSavedGame, saveGame, loadSetup, saveSetup, setupPlayers, setupToSettings, DEFAULT_SETUP } from '../../src/storage';
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

describe('frontier setup persistence', () => {
  it('defaults off, restores boolean opt-in, and excludes fixed scenarios', () => {
    expect(loadSetup().frontierMode).toBe(false);
    mem.set('infweb.setup', JSON.stringify({ frontierMode: 'true' }));
    expect(loadSetup().frontierMode).toBe(false);
    saveSetup({ ...DEFAULT_SETUP, frontierMode: true });
    expect(loadSetup().frontierMode).toBe(true);
    expect(setupToSettings(loadSetup()).frontierMode).toBe(true);
    expect(startMatch(setupToSettings(loadSetup()), 31).objectives).toHaveLength(3);
    expect(setupToSettings({ ...loadSetup(), scenario: 'titans' }).frontierMode).toBeUndefined();
  });
});

describe('experimental darkness in ordinary setup', () => {
  it('does not opt legacy or malformed preferences into new rules', () => {
    for (const saved of [{ darkness: true }, { darkness: true, signalFires: 'true', blind: 1 }]) {
      mem.set('infweb.setup', JSON.stringify(saved));
      expect(loadSetup()).toMatchObject({ signalFires: false, blind: false });
      expect(setupToSettings(loadSetup())).not.toHaveProperty('signalFires');
    }
  });

  it.each(['signalFires', 'blind'] as const)('restores %s independently with its prerequisite', (mode) => {
    mem.set('infweb.setup', JSON.stringify({ [mode]: true }));
    const prefs = loadSetup();
    expect(prefs).toMatchObject({ darkness: true, [mode]: true });
    saveSetup(prefs);
    const settings = setupToSettings(loadSetup());
    expect(settings).toMatchObject({ darkness: true, [mode]: true });
    expect(settings).not.toHaveProperty(mode === 'blind' ? 'signalFires' : 'blind');
    const game = startMatch(settings, 12);
    saveGame({ state: game, initial: structuredClone(game) });
    expect(loadSavedGame()?.state.settings).toEqual(game.settings);
    expect(loadSavedGame()?.initial.settings).toEqual(game.settings);
  });

  it('never imports the ordinary experiments into a scenario', () => {
    const prefs = { ...DEFAULT_SETUP, darkness: true, blind: true, signalFires: true };
    for (const scenario of ['titans', 'landing'] as const) {
      const settings = setupToSettings({ ...prefs, scenario });
      expect(settings.signalFires).toBeUndefined();
      expect(!!settings.blind).toBe(scenario === 'landing');
    }
  });
});

describe('setup with a scenario', () => {
  it('fixes the map, seats and modes; seat types are the chosen ones or the recommended ones', () => {
    saveSetup({ ...DEFAULT_SETUP, scenario: 'landing', scenarioSeats: { titans: ['human', 'master', 'god'] } });
    let s = loadSetup();
    expect(setupPlayers(s)).toEqual(SCENARIO_META.landing.players);
    const settings = setupToSettings(s);
    expect(settings).toMatchObject({ puzzle: 'landing', size: 'XL', darkness: true, symmetry: false, shuffle: true });
    const st = startMatch(settings, 5);
    expect(st.settings.puzzle).toBe('landing');
    expect(st.field.cells.length).toBeGreaterThan(150);

    saveSetup({ ...s, scenario: 'titans' });
    s = loadSetup();
    expect(setupPlayers(s)).toEqual(['human', 'master', 'god']);
    expect(setupToSettings(s).unions).toBe(true);
    // a scenario with seats of its own is never shuffled
    expect(setupToSettings(s).shuffle).toBe(false);
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
