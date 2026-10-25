import type { Lang } from './i18n';
import { SIZE_ORDER, type FieldSize, type MatchKind, type MatchSettings, type MatchState, type PlayerType } from './core/types';
import { isScenarioId, scenarioSetup, SCENARIO_META, seatsFit, type ScenarioConfig, type ScenarioId } from './core/scenarios';
import { betterMedal, isTier, type MedalTier } from './medals';

const PREFIX = 'infweb.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** A plain object (not null, not an array): the only shape a stored record may have. */
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isSize = (v: unknown): v is FieldSize => typeof v === 'string' && (SIZE_ORDER as string[]).includes(v);
const PLAYER_TYPES: PlayerType[] = ['human', 'remote', 'online', 'freak', 'dummy', 'hunter', 'master', 'god', 'duelHunter'];
const MATCH_KINDS: MatchKind[] = ['single', 'daily', 'duelTraining', 'duelLocal', 'duelOnline', 'battleOnline'];

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

const SETTING_CHOICES: Partial<Record<keyof Settings, readonly unknown[]>> = {
  lang: [null, 'ru', 'en'],
  speed: ['instant', 'fast', 'normal', 'slow'],
  cellLines: [100, 50, 0],
  palette: ['main', 'classic', 'soft'],
};

/** Saved settings, checked field by field: anything malformed falls back to its default. */
export function loadSettings(): Settings {
  const raw = read<unknown>('settings', {});
  const saved: Record<string, unknown> = isObj(raw) ? { ...raw } : {};
  // v2: the default bot speed became "fast"; an untouched old default moves along
  if (!saved.v && saved.speed === 'normal') saved.speed = 'fast';
  const out: Settings = { ...DEFAULT_SETTINGS };
  const o = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!(key in saved)) continue;
    const v = saved[key];
    const choices = SETTING_CHOICES[key];
    const ok = choices ? choices.includes(v) : typeof v === typeof DEFAULT_SETTINGS[key] && v !== null;
    if (ok) o[key] = v;
  }
  return out;
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
  /** size and modes chosen per configurable scenario (its defaults when missing) */
  scenarioConfig: Partial<Record<ScenarioId, ScenarioConfig>>;
}

export const DEFAULT_SETUP: SetupPrefs = {
  size: 'M',
  players: ['human', 'hunter', 'master', 'hunter'],
  darkness: false,
  symmetry: true,
  crowded: false,
  unions: false,
  shuffle: false,
  scenario: null,
  scenarioSeats: {},
  scenarioConfig: {},
};

/** Seat types the setup offers (a saved list may hold nothing else). */
const SEAT_TYPES: PlayerType[] = ['dummy', 'hunter', 'master', 'god', 'human', 'online'];

/** A seat list of a battle: 2-6 setup seat types (extra seats are cut), the first one is the player. Null when unusable. */
function cleanSeats(list: unknown): PlayerType[] | null {
  if (!Array.isArray(list)) return null;
  // Psycho is no longer offered: old setups get a Dummy in its place
  const seats = list
    .map((p) => (p === 'freak' ? 'dummy' : p))
    .filter((p): p is PlayerType => SEAT_TYPES.includes(p))
    .slice(0, 6);
  if (seats.length < 2) return null;
  seats[0] = 'human';
  return seats;
}

/** Saved battle setup, checked field by field: anything malformed falls back to its default. */
export function loadSetup(): SetupPrefs {
  const raw = read<unknown>('setup', {});
  const saved: Record<string, unknown> = isObj(raw) ? raw : {};
  const s: SetupPrefs = { ...DEFAULT_SETUP, players: [...DEFAULT_SETUP.players], scenarioSeats: {}, scenarioConfig: {} };
  if (isSize(saved.size)) s.size = saved.size;
  s.players = cleanSeats(saved.players) ?? s.players;
  for (const k of ['darkness', 'symmetry', 'crowded', 'unions', 'shuffle'] as const) {
    if (typeof saved[k] === 'boolean') s[k] = saved[k] as boolean;
  }
  s.scenario = isScenarioId(saved.scenario) ? saved.scenario : null;
  const savedSeats = isObj(saved.scenarioSeats) ? saved.scenarioSeats : {};
  const savedConfig = (isObj(saved.scenarioConfig) ? saved.scenarioConfig : {}) as Record<string, ScenarioConfig | null>;
  // keep only seat lists that still fit their scenario
  const seats: SetupPrefs['scenarioSeats'] = {};
  for (const [id, list] of Object.entries(savedSeats)) {
    if (!isScenarioId(id) || !Array.isArray(list) || !seatsFit(id, list.length)) continue;
    if (list[0] !== 'human' || !list.every((p) => SEAT_TYPES.includes(p))) continue;
    seats[id] = list as PlayerType[];
  }
  s.scenarioSeats = seats;
  // and only choices a configurable scenario offers
  const config: SetupPrefs['scenarioConfig'] = {};
  for (const [id, c] of Object.entries(savedConfig)) {
    const offer = isScenarioId(id) ? SCENARIO_META[id].configurable : undefined;
    if (!offer || !c || typeof c !== 'object') continue;
    const keep: ScenarioConfig = {};
    if (c.size && offer.sizes.includes(c.size)) keep.size = c.size;
    if (typeof c.unions === 'boolean' && offer.modes.includes('unions')) keep.unions = c.unions;
    config[id as ScenarioId] = keep;
  }
  s.scenarioConfig = config;
  return s;
}

/** Seat types of a scenario: the player's choice, or the recommended ones. */
export function scenarioSeats(s: SetupPrefs, id: ScenarioId): PlayerType[] {
  return [...(s.scenarioSeats[id] ?? SCENARIO_META[id].players)];
}

/** Size and modes of a scenario as the player set them up (its own where it allows no choice). */
export function scenarioOptions(s: SetupPrefs, id: ScenarioId): { size: FieldSize; unions: boolean } {
  return scenarioSetup(id, s.scenarioConfig[id]);
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
    const { size, unions } = scenarioOptions(s, s.scenario);
    return {
      kind: 'single',
      size,
      players: scenarioSeats(s, s.scenario),
      darkness: !!m.darkness,
      symmetry: false,
      crowded: !!m.crowded,
      unions,
      // only a configurable scenario has equal seats to shuffle
      shuffle: !!m.configurable && s.shuffle,
      duelRules: false,
      puzzle: s.scenario,
      ...(m.blind ? { blind: true } : {}),
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

/** Enough of a match state to resume it without crashing: the shape the game screen relies on. */
export function isMatchState(st: unknown): st is MatchState {
  if (!isObj(st) || st.v !== 1) return false;
  const set = st.settings;
  if (!isObj(set) || !MATCH_KINDS.includes(set.kind as MatchKind) || !isSize(set.size)) return false;
  const players = set.players;
  if (!Array.isArray(players) || players.length < 2 || players.length > 6 || !players.every((p) => PLAYER_TYPES.includes(p))) return false;
  const f = st.field;
  if (!isObj(f) || !isNum(f.w) || !isNum(f.h) || !Array.isArray(f.cells) || !f.cells.length || !Array.isArray(f.adj)) return false;
  if (f.adj.length !== f.cells.length || !Array.isArray(f.starts) || !Array.isArray(f.walls)) return false;
  for (const c of f.cells) if (!isObj(c) || !isNum(c.power) || !isNum(c.maxPower) || !isNum(c.owner) || !isNum(c.x) || !isNum(c.y)) return false;
  if (!f.adj.every((a) => Array.isArray(a))) return false;
  if (!isNum(st.turn) || !isNum(st.current) || st.current < 0 || st.current >= players.length) return false;
  if (st.phase !== 'attack' && st.phase !== 'power') return false;
  if (!isNum(st.powerLeft) || !isNum(st.seed) || !isNum(st.selected) || !isObj(st.chronicle) || !Array.isArray(st.luck)) return false;
  if (!Array.isArray(st.outAt) || st.outAt.length !== players.length || st.rng === undefined) return false;
  return st.ended === null || isObj(st.ended);
}

export function loadSavedGame(): SavedGame | null {
  const g = read<unknown>('game', null);
  if (!isObj(g) || !isMatchState(g.state) || g.state.ended) return null;
  // the round-0 copy only serves "restart on this map": the current state stands in for a broken one
  const initial = isMatchState(g.initial) ? g.initial : structuredClone(g.state);
  return { state: g.state, initial };
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

function isRecord(r: unknown): r is GameRecord {
  return (
    isObj(r) &&
    isNum(r.at) &&
    MATCH_KINDS.includes(r.kind as MatchKind) &&
    isSize(r.size) &&
    Array.isArray(r.opponents) &&
    r.opponents.every((p) => PLAYER_TYPES.includes(p)) &&
    isNum(r.humans) &&
    typeof r.win === 'boolean' &&
    isNum(r.rounds) &&
    isNum(r.captured)
  );
}

/** Saved statistics: malformed records are dropped, a malformed counter starts from zero. */
export function loadStats(): Stats {
  const raw = read<unknown>('stats', null);
  const s: Record<string, unknown> = isObj(raw) ? raw : {};
  const records = Array.isArray(s.records) ? s.records.filter(isRecord).map((r) => ({ ...r, ms: isNum(r.ms) ? r.ms : 0 })) : [];
  const streak = isNum(s.streak) && s.streak >= 0 ? s.streak : 0;
  const bestStreak = isNum(s.bestStreak) && s.bestStreak >= streak ? s.bestStreak : streak;
  return { records, streak, bestStreak };
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

/** Saved daily results: malformed days are dropped. */
export function loadDaily(): Record<string, DailyResult> {
  const raw = read<unknown>('daily2', null);
  const out: Record<string, DailyResult> = {};
  if (!isObj(raw)) return out;
  for (const [id, r] of Object.entries(raw)) {
    if (!isObj(r) || !isNum(r.attempts) || r.attempts < 0) continue;
    const best = isNum(r.bestRounds) ? r.bestRounds : null;
    out[id] = { attempts: r.attempts, bestRounds: best };
  }
  return out;
}

export function updateDaily(id: string, win: boolean, rounds: number) {
  const all = loadDaily();
  const r = all[id] ?? { attempts: 0, bestRounds: null };
  r.attempts++;
  if (win && (r.bestRounds === null || rounds < r.bestRounds)) r.bestRounds = rounds;
  all[id] = r;
  write('daily2', all);
}

// ---------------------------------------------------------------- scenario medals

export interface Medal {
  tier: MedalTier;
  /** when it was earned (or upgraded to gold) */
  at: number;
}

interface MedalsFile {
  v: 1;
  medals: Record<string, Medal>;
}

/** Every well-formed entry, including scenarios that are not offered any more (kept in case they return). */
function readMedals(): Record<string, Medal> {
  const out: Record<string, Medal> = {};
  const f = read<Partial<MedalsFile> | null>('medals', null);
  if (!f || typeof f !== 'object' || f.v !== 1 || !f.medals || typeof f.medals !== 'object') return out;
  for (const [id, m] of Object.entries(f.medals)) {
    if (m && typeof m === 'object' && isTier(m.tier) && Number.isFinite(m.at)) out[id] = { tier: m.tier, at: m.at };
  }
  return out;
}

/** Medals of the scenarios there are. */
export function loadMedals(): Partial<Record<ScenarioId, Medal>> {
  const all = readMedals();
  return Object.fromEntries(Object.entries(all).filter(([id]) => isScenarioId(id)));
}

/** Award a medal; returns the tier when it is new or an upgrade, null when nothing changed. */
export function awardMedal(id: ScenarioId, tier: MedalTier, at = Date.now()): MedalTier | null {
  const all = readMedals();
  if (!betterMedal(all[id]?.tier, tier)) return null;
  all[id] = { tier, at };
  write('medals', { v: 1, medals: all } satisfies MedalsFile);
  return tier;
}

export function resetAllData() {
  write('stats', null);
  write('daily', null);
  write('daily2', null);
  write('medals', null);
}

/** Every key of the game, in both storages: settings, setup, the saved match, stats, medals, duels. */
export function resetGameData() {
  for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      if (!store) continue;
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k?.startsWith(PREFIX)) keys.push(k);
      }
      keys.forEach((k) => store.removeItem(k));
    } catch {
      /* storage blocked: nothing to clear */
    }
  }
}
