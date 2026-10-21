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

/** Deterministic settings of the daily map: same for every player on that date. */
export function dailySettings(id: string): MatchSettings {
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

export function dailySeed(id: string): number {
  return hashString(`daily-map:${id}`);
}

export function createDailyMatch(id: string): MatchState {
  return createMatch(dailySettings(id), { seed: dailySeed(id) });
}
