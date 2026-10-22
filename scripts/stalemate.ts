/**
 * Stalemate rate: share of bot-only games that hit the round cap (nobody wins), per configuration.
 * Deterministic per seed, so runs before and after a map generator change compare the same games.
 *
 * Usage: npx vite-node scripts/stalemate.ts -- [bot=hunter] [games=120] [sizes=M,L,XL] [cap=200]
 *          [configs=sym3,rand3,rand5,rand6] (suffix c = crowded, e.g. rand5c) [playouts=300] [offset=0] [json=1]
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { chokePoints } from '../src/core/connectivity';
import { createMatch } from '../src/core/engine';
import type { BotType, FieldSize, MatchSettings } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const bot = get('bot', 'hunter') as BotType;
const games = Number(get('games', '120'));
const sizes = get('sizes', 'M,L,XL').split(',') as FieldSize[];
const cap = Number(get('cap', '200'));
const configs = get('configs', 'sym3,rand3,rand5,rand6').split(',');
const playouts = Number(get('playouts', '300'));
const offset = Number(get('offset', '0'));
const json = get('json', '0') === '1';

const out: Record<string, { games: number; capped: number; rounds: number; choke: number; cappedSeeds: number[] }> = {};
const t0 = performance.now();
for (const cfg of configs) {
  const symmetry = cfg.startsWith('sym');
  // a trailing 'c' = crowded (every cell handed out at the start)
  const crowded = cfg.endsWith('c');
  const n = Number(cfg.replace(/\D/g, ''));
  const r = { games: 0, capped: 0, rounds: 0, choke: 0, cappedSeeds: [] as number[] };
  for (let gi = 0; gi < games; gi++) {
    const g = gi + offset;
    const size = sizes[g % sizes.length];
    const seed = 7000 + g;
    const settings: MatchSettings = {
      kind: 'single',
      size,
      players: Array.from({ length: n }, () => bot),
      darkness: false,
      symmetry,
      crowded,
      unions: false,
      shuffle: false,
      duelRules: false,
    };
    const m = createMatch(settings, { seed });
    const owned = Array.from({ length: n }, (_, p) => m.field.cells.findIndex((c) => c.owner === p));
    if (!crowded && chokePoints(m.field.adj, owned).length) r.choke++;
    const bots = Array.from({ length: n }, (_, i) => createBot(bot, { seed: 1000 + g * 13 + i, master: { sync: true, playouts } }));
    const res = await runMatch(settings, { seed, bots, maxRounds: cap });
    r.games++;
    r.rounds += res.rounds;
    if (res.capped) {
      r.capped++;
      r.cappedSeeds.push(seed);
    }
  }
  out[cfg] = r;
  if (!json) {
    console.log(
      `${bot} ${cfg.padEnd(6)} games ${r.games}  capped ${r.capped} (${((100 * r.capped) / r.games).toFixed(1)}%)  avg rounds ${(r.rounds / r.games).toFixed(1)}  maps with choke points ${r.choke}`,
    );
  }
}
if (json) console.log(JSON.stringify(out));
else console.log(`[${((performance.now() - t0) / 1000).toFixed(0)} s]`);
