import { Rng, hashString, randomSeed } from './core/rng';
import { buildScenario, SCENARIOS, type ScenarioId } from './core/scenarios';
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
 * Days alternate between a puzzle scenario (an unusual map with preset forces) and a battle against
 * Masters. This date is a puzzle day; the alternation runs both ways from it.
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

/** Difficulty of each scenario (from the calibration: how often an average player wins). */
const SCENARIO_LEVEL: Record<ScenarioId, number> = {
  siege: 3,
  cauldron: 3,
  bastion: 4,
  archipelago: 2,
  labyrinth: 4,
  spiral: 4,
  twofronts: 3,
  greysea: 3,
  checker: 2,
  dam: 4,
  ringmap: 2,
  hill: 3,
  awakening: 3,
  hydra: 4,
  trojan: 4,
  thermopylae: 4,
  minefield: 2,
  hourglass: 4,
  pincer: 4,
  hive: 4,
  overload: 2,
  treasury: 4,
  bridges: 3,
  spear: 4,
};

export type DailyKind = { kind: 'battle'; plan: BattlePlan } | { kind: 'puzzle'; scenario: ScenarioId };

/** What the map of a given day is. */
export function dailyKind(id: string): DailyKind {
  const n = dayNumber(id) - dayNumber(PUZZLE_ANCHOR);
  if (((n % 2) + 2) % 2 === 0) {
    // puzzles go through all scenarios in a shuffled order before any repeats
    const i = Math.floor(n / 2);
    const len = SCENARIOS.length;
    const cycle = Math.floor(i / len);
    const order = new Rng(hashString(`puzzle-cycle:${cycle}`)).shuffle([...SCENARIOS]);
    return { kind: 'puzzle', scenario: order[((i % len) + len) % len] };
  }
  return { kind: 'battle', plan: BATTLES[(parseDay(id).getDay() + 6) % 7] };
}

/** Difficulty of the daily map, 1..5. */
export function dailyLevel(id: string): number {
  const k = dailyKind(id);
  if (k.kind === 'puzzle') return SCENARIO_LEVEL[k.scenario];
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
    const st = buildScenario(k.scenario, dailySeed(id));
    st.settings = { ...st.settings, kind: 'daily', dailyId: id };
    return st;
  }
  return createMatch(dailySettings(id), { seed: dailySeed(id) });
}

/** A fresh random variation of a scenario (played outside the daily map). */
export function createPuzzleMatch(scenario: ScenarioId): MatchState {
  return buildScenario(scenario, randomSeed());
}

export { SCENARIOS, type ScenarioId };
