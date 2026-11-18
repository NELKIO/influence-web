import { beforeEach, describe, expect, it } from 'vitest';
import { loadSavedGame, saveGame, loadSetup, saveSetup, setupPlayers, setupToSettings, DEFAULT_SETUP, frontierMajority, frontierWinChoice, frontierWinOf } from '../../src/storage';
import { objectiveWinCount } from '../../src/core/objectives';
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

  it('the win requirement follows the majority of the point count until it is chosen', () => {
    expect(loadSetup()).toMatchObject({ frontierPoints: 3, frontierWin: null });
    for (const [n, k] of [[3, 2], [4, 3], [5, 3], [6, 4], [9, 5]]) {
      expect(frontierWinOf({ frontierPoints: n, frontierWin: null })).toBe(k);
      expect(frontierMajority(n)).toBe(k);
    }
    // choosing the majority again keeps following; any other value is kept and cut to the count
    expect(frontierWinChoice(7, 4)).toBeNull();
    expect(frontierWinChoice(7, 1)).toBe(1);
    expect(frontierWinChoice(4, 9)).toBe(4);
    expect(frontierWinOf({ frontierPoints: 4, frontierWin: 6 })).toBe(4);
  });

  it('stores both frontier values, rejects nonsense, and starts the chosen match', () => {
    saveSetup({ ...DEFAULT_SETUP, frontierMode: true, frontierPoints: 7, frontierWin: 1 });
    const s = loadSetup();
    expect(s).toMatchObject({ frontierPoints: 7, frontierWin: 1 });
    const settings = setupToSettings(s);
    expect(settings).toMatchObject({ frontierMode: true, frontierPointCount: 7, frontierWinCount: 1 });
    const st = startMatch(settings, 5);
    expect(st.objectives).toHaveLength(7);
    expect(objectiveWinCount(st)).toBe(1);
    // the majority of a changed count
    saveSetup({ ...DEFAULT_SETUP, frontierMode: true, frontierPoints: 6, frontierWin: null });
    expect(setupToSettings(loadSetup()).frontierWinCount).toBe(4);
    for (const bad of [{ frontierPoints: 2 }, { frontierPoints: 10 }, { frontierPoints: 4.5 }, { frontierPoints: '5' }]) {
      mem.set('infweb.setup', JSON.stringify({ frontierMode: true, ...bad }));
      expect(loadSetup().frontierPoints).toBe(3);
    }
    mem.set('infweb.setup', JSON.stringify({ frontierPoints: 5, frontierWin: 12 }));
    expect(loadSetup()).toMatchObject({ frontierPoints: 5, frontierWin: 5 });
    mem.set('infweb.setup', JSON.stringify({ frontierPoints: 5, frontierWin: 3 }));
    expect(loadSetup().frontierWin).toBeNull();
    mem.set('infweb.setup', JSON.stringify({ frontierPoints: 5, frontierWin: 'x' }));
    expect(loadSetup().frontierWin).toBeNull();
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
