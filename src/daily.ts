import { Rng, hashString } from './core/rng';
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

const LINEUPS: PlayerType[][] = [
  ['hunter', 'dummy'],
  ['hunter', 'hunter'],
  ['master'],
  ['hunter', 'freak', 'dummy'],
  ['master', 'dummy'],
  ['hunter', 'hunter', 'dummy'],
  ['master', 'freak', 'hunter'],
  ['hunter', 'dummy', 'dummy', 'freak'],
  ['master', 'hunter'],
];

/** From this date on the daily map is a hard puzzle against Masters only (earlier days keep their maps). */
export const HARD_DAILY_FROM = '2026-10-22';

interface DayPlan {
  masters: number;
  sizes: FieldSize[];
  /** chance of darkness */
  dark: number;
  unions: boolean;
  /** difficulty shown to the player, 1..5 */
  level: number;
}

/** Monday..Sunday: the week gets harder towards Sunday. */
const WEEK: DayPlan[] = [
  { masters: 1, sizes: ['M', 'L'], dark: 0, unions: false, level: 2 },
  { masters: 1, sizes: ['L'], dark: 0.25, unions: false, level: 3 },
  { masters: 2, sizes: ['L'], dark: 0, unions: false, level: 3 },
  { masters: 1, sizes: ['XL'], dark: 0.5, unions: false, level: 4 },
  { masters: 2, sizes: ['L', 'XL'], dark: 0.35, unions: false, level: 4 },
  { masters: 3, sizes: ['XL'], dark: 0.2, unions: true, level: 5 },
  { masters: 4, sizes: ['XL'], dark: 0, unions: true, level: 5 },
];

function weekPlan(id: string): DayPlan {
  return WEEK[(parseDay(id).getDay() + 6) % 7];
}

/** Difficulty of the daily map, 1..5. */
export function dailyLevel(id: string): number {
  return id >= HARD_DAILY_FROM ? weekPlan(id).level : 2;
}

/** Deterministic settings of the daily map: same for every player on that date. */
export function dailySettings(id: string): MatchSettings {
  if (id >= HARD_DAILY_FROM) return hardDailySettings(id);
  const rng = new Rng(hashString(`daily:${id}`));
  const sizes: FieldSize[] = ['M', 'M', 'L', 'L', 'L', 'XL'];
  const size = rng.pick(sizes);
  let lineup = rng.pick(LINEUPS);
  if (size === 'M' && lineup.length > 3) lineup = lineup.slice(0, 3);
  return {
    kind: 'daily',
    size,
    players: ['human', ...lineup],
    darkness: rng.float() < 0.25,
    symmetry: rng.float() < 0.6,
    crowded: false,
    unions: rng.float() < 0.15 && lineup.length >= 3,
    shuffle: false,
    duelRules: false,
    dailyId: id,
  };
}

function hardDailySettings(id: string): MatchSettings {
  const rng = new Rng(hashString(`daily-hard:${id}`));
  const plan = weekPlan(id);
  const masters: PlayerType[] = new Array(plan.masters).fill('master');
  return {
    kind: 'daily',
    size: rng.pick(plan.sizes),
    players: ['human', ...masters],
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

export function dailySeed(id: string): number {
  return hashString(`daily-map:${id}`);
}

export function createDailyMatch(id: string): MatchState {
  return createMatch(dailySettings(id), { seed: dailySeed(id) });
}
