/**
 * Frontier battles between bots: how they end (a held set of points or elimination), how long they take, and whether any stall.
 * Every seat is a bot; invariants are checked after each move, and the saved-game validator after each game.
 *
 * Usage: npx vite-node scripts/frontier-sim.ts -- [configs=p4n3k2,p4n7k4,p6n9k5] (suffix c = crowded)
 *          [games=40] [sizes=M,L,XL] [bots=hunter,master] [cap=120] [playouts=120] [offset=0]
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { createMatch } from '../src/core/engine';
import { validObjectiveFields } from '../src/core/objectives';
import type { BotType, FieldSize, MatchSettings } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const configs = get('configs', 'p4n3k2,p4n7k4,p6n9k5').split(',');
const games = Number(get('games', '40'));
const sizes = get('sizes', 'M,L,XL').split(',') as FieldSize[];
const bots = get('bots', 'hunter,master').split(',') as BotType[];
const cap = Number(get('cap', '120'));
const playouts = Number(get('playouts', '120'));
const offset = Number(get('offset', '0'));

const out: Record<string, unknown> = {};
for (const cfg of configs) {
  const [, p, n, k] = /^p(\d)n(\d)k(\d)/.exec(cfg)!.map(Number);
  const crowded = cfg.endsWith('c');
  const r = { games: 0, objective: 0, other: 0, capped: 0, rounds: [] as number[], cappedSeeds: [] as number[], badState: 0, multiHold: 0 };
  for (let gi = 0; gi < games; gi++) {
    const g = gi + offset;
    const seed = 9100 + g;
    const players = Array.from({ length: p }, (_, i) => bots[(i + g) % bots.length]);
    const settings: MatchSettings = {
      kind: 'single',
      size: sizes[g % sizes.length],
      players,
      darkness: false,
      symmetry: g % 2 === 0,
      crowded,
      unions: false,
      shuffle: false,
      duelRules: false,
      frontierMode: true,
      frontierPointCount: n,
      frontierWinCount: k,
    };
    const start = createMatch(settings, { seed });
    if (start.objectives?.length !== n) throw new Error(`${cfg} seed ${seed}: ${start.objectives?.length} points`);
    const seats = players.map((type, i) => createBot(type, { seed: 500 + g * 17 + i, master: { sync: true, playouts } }));
    // track simultaneous holds turn by turn
    let multi = false;
    const watched = seats.map((b) => {
      const w = Object.create(b) as typeof b;
      w.nextAttack = (s, c) => {
        if (s.objectiveHoldersExtra?.length) multi = true;
        return b.nextAttack(s, c);
      };
      return w;
    });
    const res = await runMatch(settings, { seed, bots: watched, maxRounds: cap, checkInvariants: true });
    r.games++;
    if (multi) r.multiHold++;
    const end = res.state.ended;
    if (!end) {
      r.capped++;
      r.cappedSeeds.push(seed);
    } else if (end.reason === 'objective') r.objective++;
    else r.other++;
    r.rounds.push(res.rounds);
    const st = res.state as unknown as Record<string, unknown>;
    if (!validObjectiveFields(st, res.state.field.cells, players.length, res.state.settings as never)) r.badState++;
  }
  const sorted = [...r.rounds].sort((a, b) => a - b);
  const line = {
    games: r.games,
    objective: r.objective,
    elimination: r.other,
    capped: r.capped,
    medianRounds: sorted[sorted.length >> 1],
    maxRounds: sorted[sorted.length - 1],
    multiHoldGames: r.multiHold,
    invalidFinalState: r.badState,
    cappedSeeds: r.cappedSeeds,
  };
  out[cfg] = line;
  console.log(cfg, JSON.stringify(line));
}
console.log(JSON.stringify(out));
