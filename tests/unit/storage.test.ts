import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  addRecord,
  awardMedal,
  loadDaily,
  loadMedals,
  loadSavedGame,
  loadSettings,
  loadSetup,
  loadStats,
  resetAllData,
  saveGame,
  saveSettings,
  saveSetup,
  scenarioOptions,
  scenarioSeats,
  setupPlayers,
  setupToSettings,
  updateDaily,
  type GameRecord,
  type SetupPrefs,
} from '../../src/storage';
import { createMatch } from '../../src/core/engine';
import { SCENARIO_META, startMatch } from '../../src/core/scenarios';
import type { MatchSettings } from '../../src/core/types';

const mem = new Map<string, string>();
function memStorage() {
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
}
const g = globalThis as { localStorage?: unknown };
beforeEach(() => {
  mem.clear();
  g.localStorage = memStorage();
});

const raw = (k: string, v: string) => mem.set('infweb.' + k, v);
const stored = (k: string) => JSON.parse(mem.get('infweb.' + k) ?? 'null');

const rec = (over: Partial<GameRecord> = {}): GameRecord => ({
  at: 1,
  kind: 'single',
  size: 'M',
  opponents: ['hunter'],
  humans: 1,
  win: true,
  rounds: 10,
  captured: 20,
  ms: 1000,
  ...over,
});

function match(over: Partial<MatchSettings> = {}) {
  return createMatch(
    { kind: 'single', size: 'S', players: ['human', 'dummy'], darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false, ...over },
    { seed: 7 },
  );
}

/** Values a corrupted or hand-edited key might hold. */
const GARBAGE = ['{not json', '', 'null', '5', '"text"', '[]', '[1,2]', 'true', '{}'];

// ---------------------------------------------------------------- settings

describe('settings', () => {
  it('defaults from an empty storage', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('save and load round-trip, stored with a version', () => {
    const s = { ...DEFAULT_SETTINGS, lang: 'en' as const, sound: false, speed: 'slow' as const, cellLines: 50 as const, palette: 'soft' as const };
    saveSettings(s);
    expect(stored('settings').v).toBe(2);
    expect(loadSettings()).toEqual(s);
    // the version marker does not leak into the settings
    expect('v' in loadSettings()).toBe(false);
  });

  it('v1 (no version): the old default speed "normal" becomes "fast", other speeds stay', () => {
    raw('settings', JSON.stringify({ speed: 'normal', sound: false }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, speed: 'fast', sound: false });
    raw('settings', JSON.stringify({ speed: 'slow' }));
    expect(loadSettings().speed).toBe('slow');
  });

  it('v2: "normal" chosen on purpose stays', () => {
    raw('settings', JSON.stringify({ speed: 'normal', v: 2 }));
    expect(loadSettings().speed).toBe('normal');
  });

  it('an old file missing newer fields gets their defaults', () => {
    raw('settings', JSON.stringify({ lang: 'ru', v: 2 }));
    const s = loadSettings();
    expect(s.lang).toBe('ru');
    expect(s.trainingLocalFirst).toBe(DEFAULT_SETTINGS.trainingLocalFirst);
    expect(s.lowFx).toBe(DEFAULT_SETTINGS.lowFx);
  });

  it('broken JSON falls back to the defaults', () => {
    raw('settings', '{not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

// ---------------------------------------------------------------- setup

describe('battle setup', () => {
  it('defaults from an empty storage', () => {
    expect(loadSetup()).toEqual(DEFAULT_SETUP);
  });

  it('round-trip', () => {
    const s: SetupPrefs = { ...DEFAULT_SETUP, size: 'L', players: ['human', 'god', 'master'], darkness: true, unions: true, shuffle: true };
    saveSetup(s);
    expect(loadSetup()).toEqual(s);
  });

  it('migrates old seats: Psycho becomes Dummy, seat 0 is always you, at most six seats', () => {
    raw('setup', JSON.stringify({ size: 'S', players: ['hunter', 'freak', 'master', 'freak', 'god', 'hunter', 'master', 'dummy'] }));
    const s = loadSetup();
    expect(s.players).toEqual(['human', 'dummy', 'master', 'dummy', 'god', 'hunter']);
    expect(s.size).toBe('S');
    // fields the old file did not have
    expect(s.scenario).toBeNull();
    expect(s.scenarioSeats).toEqual({});
    expect(s.scenarioConfig).toEqual({});
    expect(s.shuffle).toBe(false);
  });

  it('drops a retired scenario and bad seat lists', () => {
    raw(
      'setup',
      JSON.stringify({
        ...DEFAULT_SETUP,
        scenario: 'hill',
        scenarioSeats: {
          hill: ['human', 'master', 'god'],
          titans: ['human', 'master', 'robot'],
          olympus: 'human',
          landing: ['human', 'god', 'master'],
          siege: ['hunter', 'master'],
        },
      }),
    );
    const s = loadSetup();
    expect(s.scenario).toBeNull();
    // only the night drop (3 seats fit its 3..6) survives
    expect(s.scenarioSeats).toEqual({ landing: ['human', 'god', 'master'] });
  });

  it('keeps only the choices a configurable scenario offers', () => {
    raw(
      'setup',
      JSON.stringify({
        ...DEFAULT_SETUP,
        scenarioConfig: {
          landing: { size: 'S', unions: true },
          titans: { size: 'L', unions: false },
          nope: { size: 'L' },
          raid: null,
        },
      }),
    );
    const s = loadSetup();
    expect(s.scenarioConfig).toEqual({ landing: { unions: true } });
    raw('setup', JSON.stringify({ ...DEFAULT_SETUP, scenarioConfig: { landing: { size: 'XXL', unions: 'yes' } } }));
    expect(loadSetup().scenarioConfig).toEqual({ landing: { size: 'XXL' } });
  });

  it('broken JSON falls back to the defaults', () => {
    raw('setup', '{not json');
    expect(loadSetup()).toEqual(DEFAULT_SETUP);
  });

  it('scenario seats and options: the chosen ones or the scenario’s own', () => {
    const s: SetupPrefs = { ...DEFAULT_SETUP, scenario: 'landing', scenarioSeats: { landing: ['human', 'hunter', 'hunter'] }, scenarioConfig: { landing: { size: 'L', unions: true } } };
    expect(scenarioSeats(s, 'landing')).toEqual(['human', 'hunter', 'hunter']);
    expect(scenarioSeats(s, 'titans')).toEqual(SCENARIO_META.titans.players);
    // a copy, not the stored list
    scenarioSeats(s, 'titans').push('god');
    expect(SCENARIO_META.titans.players).toHaveLength(3);
    expect(scenarioOptions(s, 'landing')).toEqual({ size: 'L', unions: true });
    expect(scenarioOptions(s, 'titans')).toEqual({ size: 'L', unions: true });
    expect(scenarioOptions(s, 'raid')).toEqual({ size: SCENARIO_META.raid.size, unions: false });
    expect(setupPlayers(s)).toEqual(['human', 'hunter', 'hunter']);
    expect(setupPlayers({ ...s, scenario: null })).toEqual(DEFAULT_SETUP.players);
  });
});

describe('setupToSettings', () => {
  it('an ordinary battle takes the modes as set, never duel rules', () => {
    const s: SetupPrefs = { ...DEFAULT_SETUP, size: 'XL', players: ['human', 'god', 'dummy'], darkness: true, symmetry: false, crowded: true, unions: true, shuffle: true };
    const m = setupToSettings(s);
    expect(m).toEqual({
      kind: 'single',
      size: 'XL',
      players: ['human', 'god', 'dummy'],
      darkness: true,
      symmetry: false,
      crowded: true,
      unions: true,
      shuffle: true,
      duelRules: false,
    });
    // the seat list is a copy
    m.players.push('hunter');
    expect(s.players).toHaveLength(3);
  });

  it('a fixed scenario ignores the ordinary modes and the shuffle', () => {
    const s: SetupPrefs = { ...DEFAULT_SETUP, darkness: true, crowded: true, unions: false, symmetry: true, shuffle: true, scenario: 'titans' };
    const m = setupToSettings(s);
    expect(m).toMatchObject({ kind: 'single', puzzle: 'titans', size: 'L', players: SCENARIO_META.titans.players, darkness: false, symmetry: false, crowded: false, unions: true, shuffle: false, duelRules: false });
    expect(m.blind).toBeUndefined();
  });

  it('the night drop takes its size, unions, seats and shuffle from the setup', () => {
    const s: SetupPrefs = {
      ...DEFAULT_SETUP,
      scenario: 'landing',
      shuffle: true,
      scenarioSeats: { landing: ['human', 'hunter', 'dummy', 'hunter'] },
      scenarioConfig: { landing: { size: 'L', unions: true } },
    };
    const m = setupToSettings(s);
    expect(m).toMatchObject({ puzzle: 'landing', size: 'L', unions: true, darkness: true, blind: true, shuffle: true, players: ['human', 'hunter', 'dummy', 'hunter'] });
    expect(setupToSettings({ ...s, shuffle: false }).shuffle).toBe(false);
  });

  it('a shuffled night drop deals the seats in a different order on some seeds (you included)', () => {
    const s: SetupPrefs = {
      ...DEFAULT_SETUP,
      scenario: 'landing',
      shuffle: true,
      scenarioSeats: { landing: ['human', 'hunter', 'dummy'] },
      scenarioConfig: { landing: { size: 'L' } },
    };
    const humanSeats = new Set<number>();
    for (let seed = 1; seed <= 6; seed++) {
      const st = startMatch(setupToSettings(s), seed);
      expect([...st.settings.players].sort()).toEqual(['dummy', 'human', 'hunter']);
      expect(st.settings.shuffle).toBe(true);
      expect(st.settings.puzzle).toBe('landing');
      humanSeats.add(st.settings.players.indexOf('human'));
      expect(st.viewer).toBe(st.settings.players.indexOf('human'));
    }
    expect(humanSeats.size).toBeGreaterThan(1);
    // the same seed deals the same order
    expect(startMatch(setupToSettings(s), 3).settings.players).toEqual(startMatch(setupToSettings(s), 3).settings.players);
  });

  it('an unshuffled night drop keeps you in seat 0', () => {
    const s: SetupPrefs = { ...DEFAULT_SETUP, scenario: 'landing', shuffle: false, scenarioSeats: { landing: ['human', 'hunter', 'dummy'] }, scenarioConfig: { landing: { size: 'L' } } };
    for (let seed = 1; seed <= 3; seed++) expect(startMatch(setupToSettings(s), seed).settings.players).toEqual(['human', 'hunter', 'dummy']);
  });
});

// ---------------------------------------------------------------- saved game

describe('saved game', () => {
  it('round-trip; a finished or old-format game is not offered; null clears it', () => {
    expect(loadSavedGame()).toBeNull();
    const st = match();
    saveGame({ state: st, initial: st });
    expect(loadSavedGame()?.state.seed).toBe(st.seed);

    saveGame({ state: { ...st, ended: { winner: 0, humanWon: true, reason: 'elimination' } } as typeof st, initial: st });
    expect(loadSavedGame()).toBeNull();

    raw('game', JSON.stringify({ state: { ...st, v: 0 }, initial: st }));
    expect(loadSavedGame()).toBeNull();

    saveGame({ state: st, initial: st });
    saveGame(null);
    expect(mem.has('infweb.game')).toBe(false);
    expect(loadSavedGame()).toBeNull();
  });

  it.each(GARBAGE)('garbage %j is not offered', (v) => {
    raw('game', v);
    expect(loadSavedGame()).toBeNull();
  });
});

// ---------------------------------------------------------------- stats

describe('stats', () => {
  it('defaults from an empty storage', () => {
    expect(loadStats()).toEqual({ records: [], streak: 0, bestStreak: 0 });
  });

  it('a win streak against bots; a defeat resets it, the best stays', () => {
    addRecord(rec({ win: true }));
    addRecord(rec({ win: true, kind: 'daily' }));
    addRecord(rec({ win: true }));
    expect(loadStats()).toMatchObject({ streak: 3, bestStreak: 3 });
    addRecord(rec({ win: false }));
    expect(loadStats()).toMatchObject({ streak: 0, bestStreak: 3 });
    addRecord(rec({ win: true }));
    expect(loadStats()).toMatchObject({ streak: 1, bestStreak: 3 });
    expect(loadStats().records).toHaveLength(5);
  });

  it('online, duels, scenarios with friends and hot-seat do not touch the streak', () => {
    addRecord(rec({ win: true }));
    addRecord(rec({ win: false, kind: 'duelOnline' }));
    addRecord(rec({ win: false, kind: 'battleOnline' }));
    addRecord(rec({ win: false, kind: 'duelLocal' }));
    addRecord(rec({ win: false, kind: 'duelTraining' }));
    addRecord(rec({ win: false, humans: 2 }));
    addRecord(rec({ win: true, humans: 0 }));
    expect(loadStats()).toMatchObject({ streak: 1, bestStreak: 1 });
    expect(loadStats().records).toHaveLength(7);
  });

  it('keeps the last 2000 records', () => {
    raw('stats', JSON.stringify({ records: Array.from({ length: 2000 }, (_, i) => rec({ at: i })), streak: 0, bestStreak: 0 }));
    addRecord(rec({ at: 5000 }));
    const s = loadStats();
    expect(s.records).toHaveLength(2000);
    expect(s.records[0].at).toBe(1);
    expect(s.records[1999].at).toBe(5000);
  });

  it('broken JSON falls back to empty stats', () => {
    raw('stats', '{not json');
    expect(loadStats()).toEqual({ records: [], streak: 0, bestStreak: 0 });
    addRecord(rec());
    expect(loadStats()).toMatchObject({ streak: 1, bestStreak: 1 });
  });
});

// ---------------------------------------------------------------- daily

describe('daily results', () => {
  it('counts attempts and keeps the fewest rounds of a won attempt', () => {
    expect(loadDaily()).toEqual({});
    updateDaily('2026-10-01', false, 5);
    expect(loadDaily()['2026-10-01']).toEqual({ attempts: 1, bestRounds: null });
    updateDaily('2026-10-01', true, 30);
    updateDaily('2026-10-01', true, 40);
    expect(loadDaily()['2026-10-01']).toEqual({ attempts: 3, bestRounds: 30 });
    updateDaily('2026-10-01', true, 12);
    updateDaily('2026-10-01', false, 3);
    expect(loadDaily()['2026-10-01']).toEqual({ attempts: 5, bestRounds: 12 });
    updateDaily('2026-10-02', true, 50);
    expect(Object.keys(loadDaily()).sort()).toEqual(['2026-10-01', '2026-10-02']);
    // stored under the second-version key
    expect(mem.has('infweb.daily2')).toBe(true);
  });

  it('broken JSON falls back to no results', () => {
    raw('daily2', '{not json');
    expect(loadDaily()).toEqual({});
    updateDaily('d', true, 9);
    expect(loadDaily()).toEqual({ d: { attempts: 1, bestRounds: 9 } });
  });
});

// ---------------------------------------------------------------- reset

describe('resetAllData', () => {
  it('removes stats, daily results (both versions) and medals; keeps settings, setup and the saved game', () => {
    saveSettings({ ...DEFAULT_SETTINGS, lang: 'en' });
    saveSetup({ ...DEFAULT_SETUP, size: 'L' });
    const st = match();
    saveGame({ state: st, initial: st });
    addRecord(rec());
    updateDaily('x', true, 3);
    raw('daily', JSON.stringify({ x: 1 }));
    awardMedal('siege', 'gold', 5);
    resetAllData();
    for (const k of ['stats', 'daily', 'daily2', 'medals']) expect(mem.has('infweb.' + k), k).toBe(false);
    expect(loadStats()).toEqual({ records: [], streak: 0, bestStreak: 0 });
    expect(loadDaily()).toEqual({});
    expect(loadMedals()).toEqual({});
    expect(loadSettings().lang).toBe('en');
    expect(loadSetup().size).toBe('L');
    expect(loadSavedGame()).not.toBeNull();
  });
});

// ---------------------------------------------------------------- broken storage

describe('storage that throws', () => {
  it('reads fall back to defaults when getItem throws (storage disabled)', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadSetup()).toEqual(DEFAULT_SETUP);
    expect(loadStats()).toEqual({ records: [], streak: 0, bestStreak: 0 });
    expect(loadDaily()).toEqual({});
    expect(loadSavedGame()).toBeNull();
    expect(loadMedals()).toEqual({});
    expect(() => {
      saveSettings(DEFAULT_SETTINGS);
      saveSetup(DEFAULT_SETUP);
      saveGame(null);
      addRecord(rec());
      updateDaily('d', true, 1);
      resetAllData();
    }).not.toThrow();
  });

  it('no localStorage at all (a worker, a sandboxed frame)', () => {
    delete g.localStorage;
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadSetup()).toEqual(DEFAULT_SETUP);
    expect(() => addRecord(rec())).not.toThrow();
  });

  it('a full storage (quota exceeded on write) keeps the previous value and does not throw', () => {
    const base = memStorage();
    let full = false;
    g.localStorage = {
      ...base,
      setItem: (k: string, v: string) => {
        if (full) throw new DOMException('quota', 'QuotaExceededError');
        base.setItem(k, v);
      },
    };
    addRecord(rec({ at: 1 }));
    full = true;
    expect(() => addRecord(rec({ at: 2 }))).not.toThrow();
    expect(loadStats().records.map((r) => r.at)).toEqual([1]);
    const st = match();
    expect(() => saveGame({ state: st, initial: st })).not.toThrow();
    expect(loadSavedGame()).toBeNull();
  });
});

// ---------------------------------------------------------------- garbage of the wrong shape

describe('valid JSON of the wrong shape', () => {
  it.each(GARBAGE)('settings %j: defaults', (v) => {
    raw('settings', v);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it.each(GARBAGE)('setup %j: defaults', (v) => {
    raw('setup', v);
    expect(loadSetup()).toEqual(DEFAULT_SETUP);
  });

  it.each(GARBAGE)('stats %j: empty stats, and a record can be added', (v) => {
    raw('stats', v);
    expect(loadStats()).toEqual({ records: [], streak: 0, bestStreak: 0 });
    expect(() => addRecord(rec())).not.toThrow();
    expect(loadStats().records).toHaveLength(1);
  });

  it.each(GARBAGE)('daily %j: no results, and a result can be added', (v) => {
    raw('daily2', v);
    expect(loadDaily()).toEqual({});
    expect(() => updateDaily('d', true, 4)).not.toThrow();
    expect(loadDaily().d).toEqual({ attempts: 1, bestRounds: 4 });
  });

  it.each(GARBAGE)('medals %j: none', (v) => {
    raw('medals', v);
    expect(loadMedals()).toEqual({});
    expect(awardMedal('siege', 'medal', 1)).toBe('medal');
  });
});
