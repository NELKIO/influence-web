/**
 * Strength sanity check: 1v1 round-robin of adjacent bot levels, seats alternated.
 * Usage: npx vite-node scripts/strength.ts [games=40] [masterPlayouts=200, 0 = real time budget] [sizes=S,M,L] [pairs]
 * FFA=<n> sets the number of "Master + 3 Hunters on L" games.
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import type { BotType, FieldSize, MatchSettings } from '../src/core/types';

const games = Number(process.argv[2] ?? 40);
const playouts = Number(process.argv[3] ?? 200);
const sizes = (process.argv[4] ?? 'S,M,L').split(',') as FieldSize[];
const pairs: [BotType, BotType][] = (process.argv[5] ?? 'master:hunter,hunter:dummy,dummy:freak')
  .split(',')
  .map((p) => p.split(':') as [BotType, BotType]);

for (const [a, b] of pairs) {
  let aw = 0;
  let bw = 0;
  let draws = 0;
  const t0 = performance.now();
  for (let g = 0; g < games; g++) {
    const size = sizes[g % sizes.length];
    const swap = g % 2 === 1;
    const types: BotType[] = swap ? [b, a] : [a, b];
    const settings: MatchSettings = {
      kind: 'single', size, players: types, darkness: false, symmetry: g % 4 >= 2,
      crowded: false, unions: false, shuffle: false, duelRules: false,
    };
    const bots = types.map((t, i) => createBot(t, { seed: 1000 + g * 7 + i, master: { sync: true, playouts: playouts > 0 ? playouts : undefined } }));
    const r = await runMatch(settings, { seed: 5000 + g, bots, maxRounds: 200 });
    if (r.winner < 0) draws++;
    else if ((r.winner === 0) !== swap) aw++;
    else bw++;
  }
  const ms = Math.round(performance.now() - t0);
  console.log(`${a} vs ${b}: ${aw}-${bw} (draws ${draws}) => ${a} ${((100 * aw) / games).toFixed(0)}%  [${ms} ms]`);
}

// The original's internal benchmark "L-3-Hunters-Master": Master + 3 Hunters on L, Master seat rotated.
const ffaGames = Number(process.env.FFA ?? Math.max(8, Math.round(games / 2)));
{
  let mw = 0;
  let decided = 0;
  const t0 = performance.now();
  for (let g = 0; g < ffaGames; g++) {
    const seat = g % 4;
    const types: BotType[] = ['hunter', 'hunter', 'hunter', 'hunter'];
    types[seat] = 'master';
    const settings: MatchSettings = {
      kind: 'single', size: 'L', players: types, darkness: false, symmetry: g % 2 === 1,
      crowded: false, unions: false, shuffle: false, duelRules: false,
    };
    const bots = types.map((t, i) => createBot(t, { seed: 77 + g * 5 + i, master: { sync: true, playouts: playouts > 0 ? playouts : undefined } }));
    const r = await runMatch(settings, { seed: 9000 + g, bots, maxRounds: 200 });
    if (r.winner >= 0) decided++;
    if (r.winner === seat) mw++;
  }
  console.log(`master vs 3 hunters (L): master won ${mw}/${ffaGames} (${decided} decided) [${Math.round(performance.now() - t0)} ms]`);
}
