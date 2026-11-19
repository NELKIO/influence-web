import { Rng, hashString } from './core/rng';
import { buildScenario, CLASSIC_SCENARIOS, SCENARIO_META, type ScenarioId } from './core/scenarios';
import { createMatch, withFreshDice } from './core/engine';
import type { FieldSize, MatchSettings, MatchState, PlayerType } from './core/types';

/** Local calendar date as yyyy-mm-dd. */
export function dayId(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseDay(id: string): Date {
  const [y, m, d] = id.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Days since the first daily map (used as the map number). */
export function dayNumber(id: string): number {
  const epoch = new Date(2026, 0, 1).getTime();
  return Math.round((parseDay(id).getTime() - epoch) / 86400000) + 1;
}


/**
 * Daily maps are mostly puzzle scenarios (an unusual map with preset forces); every fourth day is a
 * battle against Masters. The schedule is counted both ways from this date (a puzzle day).
 */
export const PUZZLE_ANCHOR = '2026-10-21';

interface BattlePlan {
  bots: PlayerType[];
  sizes: FieldSize[];
  /** chance of darkness */
  dark: number;
  unions: boolean;
  level: number;
}

/** Battles by weekday (Monday first): moderately hard, harder towards the weekend. */
const BATTLES: BattlePlan[] = [
  { bots: ['master'], sizes: ['M'], dark: 0, unions: false, level: 2 },
  { bots: ['master', 'hunter'], sizes: ['L'], dark: 0, unions: false, level: 3 },
  { bots: ['master'], sizes: ['L'], dark: 0.3, unions: false, level: 3 },
  { bots: ['hunter', 'master', 'hunter'], sizes: ['L'], dark: 0, unions: false, level: 3 },
  { bots: ['master'], sizes: ['XL'], dark: 0.3, unions: false, level: 4 },
  { bots: ['master', 'master'], sizes: ['L'], dark: 0, unions: false, level: 4 },
  { bots: ['master', 'hunter', 'hunter'], sizes: ['XL'], dark: 0, unions: true, level: 4 },
];

export type DailyKind = { kind: 'battle'; plan: BattlePlan } | { kind: 'puzzle'; scenario: ScenarioId };

/** a scenario does not come back within this many puzzle days (also across switches and between cycles) */
const NO_REPEAT = 8;

/** Index among puzzle days counted from the anchor (battle days are skipped, so there are no gaps). */
function puzzleIndex(n: number): number {
  return n - Math.floor((n + 1) / 4);
}

const OCTOBER_CATALOG: ScenarioId[] = [
  'landing', 'laststand', 'olympus', 'titans', 'raid',
  ...CLASSIC_SCENARIOS.filter(id => id !== 'hill' && id !== 'ringmap'),
];

/** the scenarios the map of the day rotates through (on every date, past ones included) */
export const ROTATION: ScenarioId[] = [
  ...OCTOBER_CATALOG.filter(id => id !== 'bridges' && id !== 'treasury' && id !== 'hourglass'),
  'farshore', 'moonvale', 'sparks', 'fireflies', 'crossroads', 'highlands', 'pinwheel',
];

/** The first map of the day: the sequence of puzzle scenarios starts here. */
const FIRST_DAY = '2026-01-01';

/** first puzzle index on or after a day */
function startIndex(day: string): number {
  const n = dayNumber(day) - dayNumber(PUZZLE_ANCHOR);
  return puzzleIndex(((n % 4) + 4) % 4 === 3 ? n + 1 : n);
}

const first = startIndex(FIRST_DAY);
/** puzzle scenarios from the first day on, generated cycle by cycle on demand */
const sequence: ScenarioId[] = [];

/**
 * The scenario of a puzzle day: every cycle shuffles the rotation; whatever was played in the last
 * few puzzle days goes to its back. (Days before the first one get a plain shuffle.)
 */
function puzzleAt(i: number): ScenarioId {
  const len = ROTATION.length;
  if (i < first) return new Rng(hashString(`puzzle-cycle-early:${Math.floor(i / len)}`)).shuffle([...ROTATION])[((i % len) + len) % len];
  const j = i - first;
  for (let cycle = sequence.length / len; sequence.length <= j; cycle++) {
    const order = new Rng(hashString(`puzzle-cycle:${cycle}`)).shuffle([...ROTATION]);
    const recent = new Set(sequence.slice(-NO_REPEAT));
    sequence.push(...order.filter((id) => !recent.has(id)), ...order.filter((id) => recent.has(id)));
  }
  return sequence[j];
}

/** What the map of a given day is. */
export function dailyKind(id: string): DailyKind {
  const n = dayNumber(id) - dayNumber(PUZZLE_ANCHOR);
  // three puzzle days, then a battle: battles fall on n ≡ 3 (mod 4)
  if (((n % 4) + 4) % 4 !== 3) {
    const i = puzzleIndex(n);
    return { kind: 'puzzle', scenario: puzzleAt(i) };
  }
  return { kind: 'battle', plan: BATTLES[(parseDay(id).getDay() + 6) % 7] };
}

/** Difficulty of the daily map, 1..5. */
export function dailyLevel(id: string): number {
  const k = dailyKind(id);
  if (k.kind === 'puzzle') return SCENARIO_META[k.scenario].level;
  return k.plan.level;
}

function battleSettings(id: string, plan: BattlePlan): MatchSettings {
  const rng = new Rng(hashString(`daily-hard:${id}`));
  return {
    kind: 'daily',
    size: rng.pick(plan.sizes),
    players: ['human', ...plan.bots],
    darkness: rng.float() < plan.dark,
    // always a fair map: mirrored for 2 and 4 players, rotational for 3 and 5
    symmetry: true,
    crowded: false,
    unions: plan.unions,
    shuffle: false,
    duelRules: false,
    dailyId: id,
  };
}

/** Deterministic settings of the daily map: same for every player on that date. */
export function dailySettings(id: string): MatchSettings {
  const k = dailyKind(id);
  if (k.kind === 'battle') return battleSettings(id, k.plan);
  return createDailyMatch(id).settings;
}

export function dailySeed(id: string): number {
  return hashString(`daily-map:${id}`);
}

export function createDailyMatch(id: string): MatchState {
  const k = dailyKind(id);
  if (k.kind === 'puzzle') {
    // the gallery design with its recommended seats; the day's seed fixes the map (and Night Drop's landing spots)
    const st = buildScenario(k.scenario, dailySeed(id));
    st.settings = { ...st.settings, kind: 'daily', dailyId: id };
    return st;
  }
  return createMatch(dailySettings(id), { seed: dailySeed(id) });
}

/**
 * An attempt at the map of the day: the day's map and starting forces exactly as createDailyMatch
 * builds them for everybody, with dice of its own (a retry must not replay the same fights).
 */
export function createDailyAttempt(id: string): MatchState {
  return withFreshDice(createDailyMatch(id));
}

export type { ScenarioId };
