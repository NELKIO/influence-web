import { DIFFICULTY, type MatchState, type PlayerType } from './core/types';
import { isScenarioId, SCENARIO_META, type ScenarioId } from './core/scenarios';

/**
 * Scenario medals. A scenario's medal goes to the only person at the table (seat 0) for a win against
 * bots at least as strong as the scenario recommends, seat by seat; against nothing but Gods the medal
 * is gold. Matches with other people earn nothing: nobody can tell who really played.
 *
 * A configurable scenario counts on any size and with any modes it offers, and its seats are not tied
 * to places on the map: the opponents, strongest first, are matched against the recommended ones,
 * strongest first. With fewer seats than recommended they face the strongest recommended ones only
 * (three seats of the night drop need a God and a Master, or stronger).
 */
export type MedalTier = 'medal' | 'gold';

const PEOPLE: PlayerType[] = ['human', 'remote', 'online'];

/** Why a line-up cannot earn a medal. */
export type NoMedal = 'people' | 'weaker';

/** The medal a line-up of this scenario plays for, or why it plays for none. */
export function seatsMedal(id: ScenarioId, players: PlayerType[]): MedalTier | NoMedal {
  const rec = SCENARIO_META[id].players;
  if (players[0] !== 'human' || players.slice(1).some((p) => PEOPLE.includes(p))) return 'people';
  if (SCENARIO_META[id].configurable) {
    const strongest = (list: PlayerType[]) => list.slice(1).sort((a, b) => DIFFICULTY[b] - DIFFICULTY[a]);
    const mine = strongest(players);
    const want = strongest(rec);
    for (let i = 0; i < Math.min(mine.length, want.length); i++) if (DIFFICULTY[mine[i]] < DIFFICULTY[want[i]]) return 'weaker';
  } else {
    if (players.length !== rec.length) return 'weaker';
    for (let i = 1; i < players.length; i++) if (DIFFICULTY[players[i]] < DIFFICULTY[rec[i]]) return 'weaker';
  }
  return players.slice(1).every((p) => p === 'god') ? 'gold' : 'medal';
}

/** The medal a finished match earns (null: none). */
export function matchMedal(s: MatchState): { id: ScenarioId; tier: MedalTier } | null {
  const id = s.settings.puzzle;
  const end = s.ended;
  if (!isScenarioId(id) || !end || !(end.humanWon || end.winner === 0)) return null;
  const tier = seatsMedal(id, s.settings.players);
  return tier === 'medal' || tier === 'gold' ? { id, tier } : null;
}

export const isTier = (v: unknown): v is MedalTier => v === 'medal' || v === 'gold';

/** Whether `next` is worth more than what is already there (a gold replaces a medal, never the reverse). */
export function betterMedal(have: MedalTier | undefined, next: MedalTier): boolean {
  return !have || (have === 'medal' && next === 'gold');
}
