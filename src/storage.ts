import type { Lang } from './i18n';
import type { FieldSize, MatchKind, MatchSettings, MatchState, PlayerType } from './core/types';
import { isScenarioId, SCENARIO_META, type ScenarioId } from './core/scenarios';

const PREFIX = 'infweb.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: ignore */
  }
}

// ---------------------------------------------------------------- settings

export type GameSpeed = 'instant' | 'fast' | 'normal' | 'slow';
export type Palette = 'main' | 'classic' | 'soft';

export interface Settings {
  lang: Lang | null;
  sound: boolean;
  vibration: boolean;
  speed: GameSpeed;
  confirmEnd: boolean;
  showChance: boolean;
  inactiveCells: boolean;
  cellLines: 100 | 50 | 0;
  colorblind: boolean;
  palette: Palette;
  lowFx: boolean;
  trainingLocalFirst: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: null,
  sound: true,
  vibration: true,
  speed: 'fast',
  confirmEnd: true,
  showChance: true,
  inactiveCells: true,
  cellLines: 100,
  colorblind: false,
  palette: 'main',
  lowFx: false,
  trainingLocalFirst: false,
};

export const SPEED_MS: Record<GameSpeed, number> = { instant: 0, fast: 200, normal: 350, slow: 600 };

export function loadSettings(): Settings {
  const saved = read<Partial<Settings> & { v?: number }>('settings', {});
  // v2: the default bot speed became "fast"; an untouched old default moves along
  if (!saved.v && saved.speed === 'normal') saved.speed = 'fast';
  const { v: _v, ...rest } = saved;
  void _v;
  return { ...DEFAULT_SETTINGS, ...rest };
}

export function saveSettings(s: Settings) {
  write('settings', { ...s, v: 2 });
}

// ---------------------------------------------------------------- battle setup

export interface SetupPrefs {
  size: FieldSize;
  players: PlayerType[];
  darkness: boolean;
  symmetry: boolean;
  crowded: boolean;
  unions: boolean;
  shuffle: boolean;
  /** a scenario fixes the map, the seats and the modes (null: an ordinary map with the settings above) */
  scenario: ScenarioId | null;
  /** seat types chosen per scenario (the recommended ones when missing) */
  scenarioSeats: Partial<Record<ScenarioId, PlayerType[]>>;
}

export const DEFAULT_SETUP: SetupPrefs = {
  size: 'M',
  players: ['human', 'dummy', 'hunter', 'dummy'],
  darkness: false,
  symmetry: true,
  crowded: false,
  unions: false,
  shuffle: false,
  scenario: null,
  scenarioSeats: {},
};

const SEAT_TYPES: PlayerType[] = ['dummy', 'hunter', 'master', 'god', 'human', 'online'];

export function loadSetup(): SetupPrefs {
  const s = { ...DEFAULT_SETUP, ...read<Partial<SetupPrefs>>('setup', {}) };
  // Psycho is no longer offered: old setups get a Dummy in its place
  s.players = s.players.slice(0, 6).map((p) => (p === 'freak' ? 'dummy' : p));
  if (s.players[0] !== 'human') s.players[0] = 'human';
  if (!isScenarioId(s.scenario)) s.scenario = null;
  // keep only seat lists that still fit their scenario
  const seats: SetupPrefs['scenarioSeats'] = {};
  for (const [id, list] of Object.entries(s.scenarioSeats ?? {})) {
    if (!isScenarioId(id) || !Array.isArray(list) || list.length !== SCENARIO_META[id].players.length) continue;
    if (list[0] !== 'human' || !list.every((p) => SEAT_TYPES.includes(p))) continue;
    seats[id] = list;
  }
  s.scenarioSeats = seats;
  return s;
}

/** Seat types of a scenario: the player's choice, or the recommended ones. */
export function scenarioSeats(s: SetupPrefs, id: ScenarioId): PlayerType[] {
  return [...(s.scenarioSeats[id] ?? SCENARIO_META[id].players)];
}

/** Seats of the battle the setup describes. */
export function setupPlayers(s: SetupPrefs): PlayerType[] {
  return s.scenario ? scenarioSeats(s, s.scenario) : [...s.players];
}

export function saveSetup(s: SetupPrefs) {
  write('setup', s);
}

export function setupToSettings(s: SetupPrefs): MatchSettings {
  if (s.scenario) {
    const m = SCENARIO_META[s.scenario];
    return {
      kind: 'single',
      size: m.size,
      players: scenarioSeats(s, s.scenario),
      darkness: !!m.darkness,
      symmetry: false,
      crowded: !!m.crowded,
      unions: !!m.unions,
      shuffle: false,
      duelRules: false,
      puzzle: s.scenario,
    };
  }
  return {
    kind: 'single',
    size: s.size,
    players: [...s.players],
    darkness: s.darkness,
    symmetry: s.symmetry,
    crowded: s.crowded,
    unions: s.unions,
    shuffle: s.shuffle,
    duelRules: false,
  };
}

// ---------------------------------------------------------------- saved match

export interface SavedGame {
  state: MatchState;
  /** the match as it was at round 0, for "restart on this map" */
  initial: MatchState;
}

export function loadSavedGame(): SavedGame | null {
  const g = read<SavedGame | null>('game', null);
  if (!g || g.state?.v !== 1 || g.state.ended) return null;
  return g;
}

export function saveGame(g: SavedGame | null) {
  write('game', g);
}

// ---------------------------------------------------------------- stats

export interface GameRecord {
  at: number;
  kind: MatchKind;
  size: FieldSize;
  opponents: PlayerType[];
  humans: number;
  win: boolean;
  rounds: number;
  captured: number;
  ms: number;
}

export interface Stats {
  records: GameRecord[];
  streak: number;
  bestStreak: number;
}

export function loadStats(): Stats {
  return read<Stats>('stats', { records: [], streak: 0, bestStreak: 0 });
}

export function addRecord(r: GameRecord) {
  const s = loadStats();
  s.records.push(r);
  if (s.records.length > 2000) s.records.splice(0, s.records.length - 2000);
  // the streak counts classic battles and daily maps against bots
  if (r.humans === 1 && (r.kind === 'single' || r.kind === 'daily')) {
    s.streak = r.win ? s.streak + 1 : 0;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  }
  write('stats', s);
}

// ---------------------------------------------------------------- daily

export interface DailyResult {
  attempts: number;
  /** fewest rounds of a won attempt */
  bestRounds: number | null;
}

export function loadDaily(): Record<string, DailyResult> {
  return read<Record<string, DailyResult>>('daily2', {});
}

export function updateDaily(id: string, win: boolean, rounds: number) {
  const all = loadDaily();
  const r = all[id] ?? { attempts: 0, bestRounds: null };
  r.attempts++;
  if (win && (r.bestRounds === null || rounds < r.bestRounds)) r.bestRounds = rounds;
  all[id] = r;
  write('daily2', all);
}

export function resetAllData() {
  write('stats', null);
  write('daily', null);
  write('daily2', null);
}
