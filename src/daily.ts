import { Rng, hashString } from './core/rng';
import { buildScenario, CLASSIC_SCENARIOS, SCENARIO_META, type ScenarioId } from './core/scenarios';
import { createMatch } from './core/engine';
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

/** The classic rotation (before the first switch): each cycle is the 24 scenarios in a shuffled order. */
function classicPuzzle(i: number): ScenarioId {
  const len = CLASSIC_SCENARIOS.length;
  const cycle = Math.floor(i / len);
  const order = new Rng(hashString(`puzzle-cycle:${cycle}`)).shuffle([...CLASSIC_SCENARIOS]);
  return order[((i % len) + len) % len];
}

/**
 * Rotations after the classic one. Each starts on a day nobody has seen yet and keeps a fixed list,
 * so adding a scenario never changes a day that is already out: it joins with a new switch. Every
 * cycle shuffles the list; whatever was played in the last few puzzle days goes to its back.
 */
const ERAS: { from: string; salt: string; scenarios: ScenarioId[] }[] = [
  // the four battles for three to six players join
  { from: '2026-10-23', salt: 'puzzle-cycle-all', scenarios: ['landing', 'laststand', 'olympus', 'titans', ...CLASSIC_SCENARIOS] },
  // the raid joins (Hollow lands is a party map and stays out of the map of the day)
  { from: '2026-10-24', salt: 'puzzle-cycle-raid', scenarios: ['landing', 'laststand', 'olympus', 'titans', ...CLASSIC_SCENARIOS, 'raid'] },
];

/** the scenarios the map of the day currently rotates through */
export const ROTATION: ScenarioId[] = ERAS[ERAS.length - 1].scenarios;

/** first puzzle index on or after a day */
function startIndex(day: string): number {
  const n = dayNumber(day) - dayNumber(PUZZLE_ANCHOR);
  return puzzleIndex(((n % 4) + 4) % 4 === 3 ? n + 1 : n);
}

const eraStart = ERAS.map((e) => startIndex(e.from));
/** puzzle scenarios of each era, generated cycle by cycle on demand */
const sequences: ScenarioId[][] = ERAS.map(() => []);

function puzzleAt(i: number): ScenarioId {
  let e = ERAS.length - 1;
  while (e >= 0 && i < eraStart[e]) e--;
  if (e < 0) return classicPuzzle(i);
  const { salt, scenarios } = ERAS[e];
  const seq = sequences[e];
  const j = i - eraStart[e];
  for (let cycle = seq.length / scenarios.length; seq.length <= j; cycle++) {
    const order = new Rng(hashString(`${salt}:${cycle}`)).shuffle([...scenarios]);
    const recent = new Set<ScenarioId>();
    for (let k = 1; k <= NO_REPEAT; k++) {
      const at = seq.length - k;
      recent.add(at >= 0 ? seq[at] : puzzleAt(eraStart[e] + at));
    }
    seq.push(...order.filter((id) => !recent.has(id)), ...order.filter((id) => recent.has(id)));
  }
  return seq[j];
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
    // the scenario as the battle setup recommends it; the seed of the day fixes the map (and the night drop's landing spots)
    const st = buildScenario(k.scenario, dailySeed(id));
    st.settings = { ...st.settings, kind: 'daily', dailyId: id };
    return st;
  }
  return createMatch(dailySettings(id), { seed: dailySeed(id) });
}

export type { ScenarioId };
