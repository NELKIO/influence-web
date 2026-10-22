/**
 * GOD strength measurements (headless, deterministic per seed).
 *
 * Usage: npx vite-node scripts/god-strength.ts -- [key=value ...]
 *   mode=duel|ffa        duel: A vs B 1v1 with alternating seats; ffa: one A against (players-1) B
 *   a=god b=master       bot types
 *   games=60 sizes=M,L,XL players=4 (ffa) offset=0 (seed offset, to split runs over processes)
 *   gr=400               GOD rollouts per decision (0 = real time budget)
 *   mp=1000              Master playouts per decision (0 = real time budget)
 *   speed=0              ctx.speedMs passed to the bots (timed mode)
 *   sym=alt|0|1          symmetric maps: alternate (default), never, always
 *   duelRules=0|1 darkness=0|1
 *   params={json}        GOD parameter overrides (A side), paramsB={json} for a GOD on the B side
 *   json=1               print one JSON line with the result (used by scripts/god-tune.ts)
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import type { Bot } from '../src/ai/types';
import type { BotType, FieldSize, MatchSettings } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const mode = get('mode', 'duel');
const A = get('a', 'god') as BotType;
const B = get('b', 'master') as BotType;
const games = Number(get('games', '60'));
const sizes = get('sizes', 'M,L,XL').split(',') as FieldSize[];
const players = Number(get('players', '4'));
const offset = Number(get('offset', '0'));
const gr = Number(get('gr', '400'));
const mp = Number(get('mp', '1000'));
const speed = Number(get('speed', '0'));
const sym = get('sym', 'alt');
const duelRules = get('duelRules', '0') === '1';
const darkness = get('darkness', '0') === '1';
const paramsA = JSON.parse(get('params', '{}'));
const paramsB = JSON.parse(get('paramsB', '{}'));
const optsA = JSON.parse(get('godA', '{}'));
const optsB = JSON.parse(get('godB', '{}'));
const json = get('json', '0') === '1';
/** seat B is typed 'human' (gets the engine's luck correction in its favour) but driven by bot B */
const bHuman = get('bHuman', '0') === '1';

interface Timing {
  n: number;
  sum: number;
  max: number;
}
const timing = new Map<string, Timing>();

/** wrap a bot to record decision times */
function timed(bot: Bot, label: string): Bot {
  const rec = (ms: number) => {
    const t = timing.get(label) ?? { n: 0, sum: 0, max: 0 };
    t.n++;
    t.sum += ms;
    t.max = Math.max(t.max, ms);
    timing.set(label, t);
  };
  return {
    type: bot.type,
    async nextAttack(s, c) {
      const t0 = performance.now();
      const r = await bot.nextAttack(s, c);
      rec(performance.now() - t0);
      return r;
    },
    async placePower(s, c) {
      const t0 = performance.now();
      const r = await bot.placePower(s, c);
      rec(performance.now() - t0);
      return r;
    },
  };
}

function make(t: BotType, seed: number, side: 'A' | 'B'): Bot {
  const bot = createBot(t, {
    seed,
    master: { sync: true, playouts: mp > 0 ? mp : undefined },
    god: { sync: true, rollouts: gr > 0 ? gr : undefined, params: side === 'A' ? paramsA : paramsB, ...(side === 'A' ? optsA : optsB) },
  });
  return timed(bot, `${t}${side}`);
}

let aw = 0;
let bw = 0;
let draws = 0;
let rounds = 0;
const t0 = performance.now();
const perSize = new Map<string, [number, number]>();
for (let gi = 0; gi < games; gi++) {
  const g = gi + offset;
  const size = sizes[g % sizes.length];
  const symmetry = sym === 'alt' ? Math.floor(g / sizes.length) % 2 === 1 : sym === '1';
  let types: BotType[];
  let aSeat: number;
  if (mode === 'duel') {
    const swap = Math.floor(g / (2 * sizes.length)) % 2 === 1 ? g % 2 === 0 : g % 2 === 1;
    types = swap ? [B, A] : [A, B];
    aSeat = swap ? 1 : 0;
  } else {
    aSeat = g % players;
    types = Array.from({ length: players }, (_, i) => (i === aSeat ? A : B));
  }
  const settings: MatchSettings = {
    kind: duelRules ? 'duelTraining' : 'single',
    size,
    players: bHuman ? types.map((t, i) => (i === aSeat ? t : 'human')) : types,
    darkness,
    symmetry,
    crowded: false,
    unions: false,
    shuffle: false,
    duelRules,
  };
  const bots = types.map((t, i) => make(t, 1000 + g * 13 + i, i === aSeat ? 'A' : 'B'));
  const r = await runMatch(settings, { seed: 5000 + g, bots, maxRounds: 200, ctx: { speedMs: speed } });
  rounds += r.rounds;
  const ps = perSize.get(size) ?? [0, 0];
  ps[1]++;
  if (r.winner < 0) draws++;
  else if (r.winner === aSeat) {
    aw++;
    ps[0]++;
  } else bw++;
  perSize.set(size, ps);
  if (!json) console.log(`game ${g} ${size}${symmetry ? 's' : ''} seat ${aSeat}: winner ${r.winner < 0 ? '-' : r.winner === aSeat ? A : B} (${r.rounds} rounds)`);
}
const ms = Math.round(performance.now() - t0);
const tim = Object.fromEntries([...timing].map(([k, t]) => [k, { avg: +(t.sum / t.n).toFixed(1), max: +t.max.toFixed(0), n: t.n }]));
if (json) {
  console.log(JSON.stringify({ aw, bw, draws, games, rounds, ms, timing: tim }));
} else {
  console.log(`${mode} ${A} vs ${B}: ${aw}-${bw} (draws ${draws}) => ${A} ${((100 * aw) / games).toFixed(1)}%  [${ms} ms, avg ${(rounds / games).toFixed(1)} rounds]`);
  console.log('per size:', Object.fromEntries([...perSize].map(([k, [w, n]]) => [k, `${w}/${n}`])));
  console.log('decision ms:', tim);
}
