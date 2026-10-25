import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  isMatchState,
  loadDaily,
  loadSavedGame,
  loadSettings,
  loadSetup,
  loadStats,
  resetGameData,
  saveGame,
  setupToSettings,
  type GameRecord,
} from '../../src/storage';
import { createMatch } from '../../src/core/engine';
import { startMatch } from '../../src/core/scenarios';
import { getLang, setLang } from '../../src/i18n';

// Hand-edited or corrupted storage, one field at a time: every loader keeps what is valid, falls back
// field by field for the rest and never throws (a throwing loader blanked the whole app).

const mem = new Map<string, string>();
const memStorage = () => ({
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
});
const g = globalThis as { localStorage?: unknown; sessionStorage?: unknown };
beforeEach(() => {
  mem.clear();
  g.localStorage = memStorage();
});
const raw = (k: string, v: unknown) => mem.set('infweb.' + k, typeof v === 'string' ? v : JSON.stringify(v));

const rec: GameRecord = { at: 5, kind: 'single', size: 'M', opponents: ['hunter'], humans: 1, win: true, rounds: 9, captured: 3, ms: 100 };

function match() {
  return createMatch(
    { kind: 'single', size: 'S', players: ['human', 'dummy'], darkness: false, symmetry: false, crowded: false, unions: false, shuffle: false, duelRules: false },
    { seed: 3 },
  );
}

describe('settings, field by field', () => {
  it.each([
    [{ lang: 'de' }, 'lang'],
    [{ lang: 5 }, 'lang'],
    [{ speed: 'turbo' }, 'speed'],
    [{ palette: 'x' }, 'palette'],
    [{ cellLines: 75 }, 'cellLines'],
    [{ sound: 'yes' }, 'sound'],
    [{ vibration: null }, 'vibration'],
    [{ lowFx: 1 }, 'lowFx'],
  ] as const)('%j: that field gets its default', (saved, key) => {
    raw('settings', { ...saved, v: 2 });
    expect(loadSettings()[key]).toEqual(DEFAULT_SETTINGS[key]);
  });

  it('keeps the valid fields next to broken ones', () => {
    raw('settings', { lang: 'en', sound: 'yes', speed: 'slow', palette: 'nope', cellLines: 0, v: 2 });
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, lang: 'en', speed: 'slow', cellLines: 0 });
  });

  it('an explicit null language means "the browser\'s" and stays', () => {
    raw('settings', { lang: null, v: 2 });
    expect(loadSettings().lang).toBeNull();
  });

  it('setLang takes only ru and en', () => {
    setLang('ru');
    setLang('de' as 'ru');
    expect(getLang()).toBe('ru');
    setLang('en');
    expect(getLang()).toBe('en');
    setLang('ru');
  });
});

describe('battle setup, field by field', () => {
  it.each([
    ['players null', { players: null }],
    ['players a string', { players: 'abc' }],
    ['no seats', { players: [] }],
    ['one seat (a match that never ends)', { players: ['human'] }],
    ['only unknown opponents', { players: ['human', 'banana'] }],
  ])('%s: the default seats', (_, saved) => {
    raw('setup', saved);
    expect(loadSetup().players).toEqual(DEFAULT_SETUP.players);
  });

  it('more than six seats are cut to six', () => {
    raw('setup', { players: ['human', 'dummy', 'hunter', 'dummy', 'dummy', 'dummy', 'master'] });
    expect(loadSetup().players).toEqual(['human', 'dummy', 'hunter', 'dummy', 'dummy', 'dummy']);
  });

  it('only the seat types the setup offers survive (remote and duelHunter are not offered)', () => {
    raw('setup', { players: ['human', 'freak', 'remote', 'duelHunter', 'god', 'banana', 'online'] });
    expect(loadSetup().players).toEqual(['human', 'dummy', 'god', 'online']);
  });

  it('an unknown size, non-boolean modes and broken scenario maps fall back', () => {
    raw('setup', { size: 'Q', darkness: 'yes', unions: true, scenario: 'nope', scenarioSeats: null, scenarioConfig: 'x' });
    expect(loadSetup()).toEqual({ ...DEFAULT_SETUP, unions: true });
  });

  it('a scenario seat list of the wrong length or types is dropped', () => {
    raw('setup', { scenario: 'landing', scenarioSeats: { landing: ['human'], siege: ['human', 'banana'] }, scenarioConfig: { landing: { size: 'Q' } } });
    const s = loadSetup();
    expect(s.scenario).toBe('landing');
    expect(s.scenarioSeats).toEqual({});
    expect(s.scenarioConfig).toEqual({ landing: {} });
  });

  it('every loaded setup starts a match of at least two', () => {
    raw('setup', { players: ['human'] });
    expect(startMatch(setupToSettings(loadSetup())).settings.players.length).toBeGreaterThanOrEqual(2);
  });

  it('startMatch refuses a match of one', () => {
    const s = setupToSettings(DEFAULT_SETUP);
    expect(() => startMatch({ ...s, players: ['human'] })).toThrow(RangeError);
  });
});

describe('saved match', () => {
  it.each([
    ['only a version', { state: { v: 1 } }],
    ['settings without a field', { state: { v: 1, settings: { kind: 'single', size: 'M' }, turn: 2 } }],
    ['no state', { initial: {} }],
    ['an array', [1, 2]],
  ])('%s: discarded', (_, saved) => {
    raw('game', saved);
    expect(loadSavedGame()).toBeNull();
  });

  it('a field with a broken cell is discarded', () => {
    const st = match();
    (st.field.cells[0] as unknown as { power: unknown }).power = 'x';
    raw('game', { state: st, initial: st });
    expect(loadSavedGame()).toBeNull();
  });

  it('a seat out of range or an unknown kind is discarded', () => {
    const a = match();
    a.current = 7;
    raw('game', { state: a, initial: a });
    expect(loadSavedGame()).toBeNull();
    const b = match();
    (b.settings as unknown as { kind: string }).kind = 'chess';
    raw('game', { state: b, initial: b });
    expect(loadSavedGame()).toBeNull();
  });

  it('a good match with a broken round-0 copy still resumes (the copy is the current state)', () => {
    const st = match();
    raw('game', { state: st, initial: null });
    const g2 = loadSavedGame();
    expect(g2?.state.seed).toBe(st.seed);
    expect(isMatchState(g2?.initial)).toBe(true);
  });

  it('round trip of a real match', () => {
    const st = match();
    saveGame({ state: st, initial: st });
    expect(loadSavedGame()?.state).toEqual(st);
  });
});

describe('stats, record by record', () => {
  it('drops records with missing or wrong fields, keeps good ones', () => {
    raw('stats', { records: [{ kind: 'single' }, null, rec, { ...rec, opponents: 'x' }, { ...rec, ms: undefined }], streak: 2, bestStreak: 4 });
    const s = loadStats();
    expect(s.records).toEqual([rec, { ...rec, ms: 0 }]);
    expect(s).toMatchObject({ streak: 2, bestStreak: 4 });
  });

  it.each([{ records: null }, { records: {} }, { streak: 'x', bestStreak: -1 }])('%j: empty and zero', (saved) => {
    raw('stats', saved);
    expect(loadStats()).toEqual({ records: [], streak: 0, bestStreak: 0 });
  });

  it('the best streak is never below the current one', () => {
    raw('stats', { records: [], streak: 5, bestStreak: 2 });
    expect(loadStats()).toMatchObject({ streak: 5, bestStreak: 5 });
  });
});

describe('daily results, day by day', () => {
  it('drops broken days, keeps good ones', () => {
    raw('daily2', { '2026-10-25': null, '2026-10-24': { attempts: 2, bestRounds: 7 }, '2026-10-23': { attempts: 'x' }, '2026-10-22': { attempts: 1, bestRounds: 'x' } });
    expect(loadDaily()).toEqual({ '2026-10-24': { attempts: 2, bestRounds: 7 }, '2026-10-22': { attempts: 1, bestRounds: null } });
  });
});

describe('resetGameData', () => {
  it('clears every infweb.* key and nothing else', () => {
    raw('settings', {});
    raw('game', {});
    raw('duelSlots', []);
    mem.set('other', '1');
    resetGameData();
    expect([...mem.keys()]).toEqual(['other']);
  });
});
