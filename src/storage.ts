import type { Lang } from './i18n';
import type { FieldSize, MatchKind, MatchSettings, MatchState, PlayerType } from './core/types';

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
}

export const DEFAULT_SETUP: SetupPrefs = {
  size: 'M',
  players: ['human', 'dummy', 'freak', 'dummy'],
  darkness: false,
  symmetry: true,
  crowded: false,
  unions: false,
  shuffle: false,
};

export function loadSetup(): SetupPrefs {
  return { ...DEFAULT_SETUP, ...read<Partial<SetupPrefs>>('setup', {}) };
}

export function saveSetup(s: SetupPrefs) {
  write('setup', s);
}

export function setupToSettings(s: SetupPrefs): MatchSettings {
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
  return read<Record<string, DailyResult>>('daily', {});
}

export function updateDaily(id: string, win: boolean, rounds: number) {
  const all = loadDaily();
  const r = all[id] ?? { attempts: 0, bestRounds: null };
  r.attempts++;
  if (win && (r.bestRounds === null || rounds < r.bestRounds)) r.bestRounds = rounds;
  all[id] = r;
  write('daily', all);
}

export function resetAllData() {
  write('stats', null);
  write('daily', null);
}
