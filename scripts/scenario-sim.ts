/**
 * Scenario matches between bots, launched the way the setup screen launches them (startMatch, seats
 * shuffled when the scenario allows it): how often a strong stand-in for you (Master) wins, by your
 * place in the turn order, how the matches end, how long they take and whether any stall.
 * Invariants are checked after every move and the saved-game validator after every match.
 *
 * Usage: npx vite-node scripts/scenario-sim.ts -- id=olympus seats=4 [games=40] [offset=0] [cap=150]
 *          [you=master] [playouts=80] [rollouts=60] [shuffle=1] [size=L]
 *          [others=master] (every other seat; default: the recommended line-up)
 *          [bonus=0,2,4] (extra first income per turn position, replaces the scenario's) [skip=1] [order=snake]
 *          [even=1] (every seat starts alike, as when people play: no knob for you; `others` plays every seat,
 *          and only the winner's place in the turn order means anything)
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { SCENARIO_META, startMatch, type ScenarioId } from '../src/core/scenarios';
import { isMatchState } from '../src/storage';
import type { BotType, FieldSize, MatchSettings, PlayerType } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const id = get('id', 'olympus') as ScenarioId;
const meta = SCENARIO_META[id];
const seats = Number(get('seats', String(meta.players.length)));
const games = Number(get('games', '40'));
const offset = Number(get('offset', '0'));
const cap = Number(get('cap', '150'));
const you = get('you', 'master') as BotType;
const playouts = Number(get('playouts', '80'));
const rollouts = Number(get('rollouts', '60'));
const shuffle = get('shuffle', '1') === '1';
const size = get('size', meta.size) as FieldSize;
const bonus = args.get('bonus')?.split(',').map(Number);
const skip = args.has('skip') ? Number(args.get('skip')) : undefined;
const order = args.get('order') as 'rotate' | 'snake' | undefined;
const even = get('even', '0') === '1';

// the recommended line-up, extended by Master / Hunter for extra seats
const others = args.get('others') as BotType | undefined;
const players: PlayerType[] = Array.from({ length: seats }, (_, i) => others ?? meta.players[i] ?? (i % 2 ? 'master' : 'hunter'));
players[0] = 'human';

const r = {
  id, seats, size, games: 0, youWon: 0, otherWon: 0, capped: 0, invalid: 0,
  reasons: {} as Record<string, number>, rounds: [] as number[], cappedSeeds: [] as number[],
  // your place in the turn order -> [games, wins]
  byPlace: {} as Record<number, [number, number]>,
  // winner's place in the turn order
  winnerPlace: {} as Record<number, number>,
};
for (let gi = 0; gi < games; gi++) {
  const g = gi + offset;
  const seed = 20_000 + g * 7919;
  const settings: MatchSettings = {
    kind: 'single', size, players, darkness: false, symmetry: false, crowded: false, unions: false,
    shuffle, duelRules: false, puzzle: id,
  };
  // people in every seat: the map is built with equal starts; bots then take every seat
  const state = startMatch(even ? { ...settings, players: players.map(() => 'human') } : settings, seed);
  if (even) {
    state.settings.players = players.map((_, i) => (i === 0 ? 'human' : others ?? 'master'));
    delete state.explored;
  }
  // candidate turn-order compensations: only the round-0 parts, which act after the map is dealt
  if (bonus || skip !== undefined || order) state.settings.orderComp = { ...(bonus ? { bonus } : {}), ...(skip ? { skip } : {}), ...(order ? { order } : {}) };
  const me = state.settings.players.indexOf('human');
  const bots = state.settings.players.map((p, slot) =>
    createBot(slot === me ? you : (p as BotType), { seed: seed + slot, master: { sync: true, playouts }, god: { sync: true, rollouts } }),
  );
  const res = await runMatch(state.settings, { seed, bots, state, maxRounds: cap, checkInvariants: true });
  r.games++;
  const place = (r.byPlace[me] ??= [0, 0]);
  place[0]++;
  const end = res.state.ended;
  if (!end) {
    r.capped++;
    r.cappedSeeds.push(seed);
  } else {
    r.reasons[end.reason] = (r.reasons[end.reason] ?? 0) + 1;
    const won = end.humanWon || res.winner === me;
    if (won) {
      r.youWon++;
      place[1]++;
    } else r.otherWon++;
    if (res.winner >= 0) r.winnerPlace[res.winner] = (r.winnerPlace[res.winner] ?? 0) + 1;
  }
  r.rounds.push(res.rounds);
  if (!isMatchState(JSON.parse(JSON.stringify(res.state)))) r.invalid++;
}
const sorted = [...r.rounds].sort((a, b) => a - b);
console.log(JSON.stringify({ ...r, others, bonus, skip, order, even, rounds: undefined, medianRounds: sorted[sorted.length >> 1], maxRounds: sorted[sorted.length - 1] }));
