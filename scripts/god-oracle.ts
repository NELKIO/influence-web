/**
 * Bias of GOD's emulated rollouts against an outcome oracle (round 7).
 *
 *  mode=collect   play GOD vs Master (same seeds and seats as scripts/god-strength.ts) and log every
 *                 re-scored opening attack decision of GOD: the position, its candidates (Master's own
 *                 choice first) and what GOD played.
 *                 npx vite-node scripts/god-oracle.ts -- mode=collect games=12 offset=0 sizes=S,M,L,XL,XXL out=dec.jsonl
 *  mode=oracle    for every logged decision and candidate: K full continuations (both seats played by
 *                 Master with mp playouts), common engine dice per continuation index; GOD's seat wins?
 *                 npx vite-node scripts/god-oracle.ts -- mode=oracle in=dec.jsonl from=0 to=20 k=16 mp=300 out=orc.jsonl
 *  mode=rollouts  for every logged decision: the paired emulated-rollout statistics of every candidate
 *                 against Master's choice, per GOD variant (GodOptions)
 *                 npx vite-node scripts/god-oracle.ts -- mode=rollouts in=dec.jsonl from=0 to=20 n=200 \
 *                   variants='{"base":{},"x":{"ownPlace":"search:64"}}' out=roll.jsonl
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { GodBrain } from '../src/ai/god';
import { alivePlayers, attack } from '../src/core/engine';
import { Rng } from '../src/core/rng';
import type { Bot } from '../src/ai/types';
import type { BotType, FieldSize, MatchSettings, MatchState } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const mode = get('mode', 'collect');
const out = get('out', 'oracle.jsonl');

interface Decision {
  id: string;
  g: number;
  turn: number;
  godSeat: number;
  state: MatchState;
  lastTo: number;
  cands: number[];
  anchor: number;
  chosen: number;
}

function settingsOf(g: number, sizes: FieldSize[]) {
  const size = sizes[g % sizes.length];
  const symmetry = Math.floor(g / sizes.length) % 2 === 1;
  const swap = Math.floor(g / (2 * sizes.length)) % 2 === 1 ? g % 2 === 0 : g % 2 === 1;
  const types: BotType[] = swap ? ['master', 'god'] : ['god', 'master'];
  const settings: MatchSettings = { kind: 'single', size, players: types, darkness: false, symmetry, crowded: false, unions: false, shuffle: false, duelRules: false };
  return { settings, godSeat: swap ? 1 : 0 };
}

const readDecisions = (): Decision[] =>
  readFileSync(get('in', 'dec.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Decision);

if (mode === 'collect') {
  const games = Number(get('games', '12'));
  const offset = Number(get('offset', '0'));
  const sizes = get('sizes', 'S,M,L,XL,XXL').split(',') as FieldSize[];
  const speed = Number(get('speed', '200'));
  const rounds = Number(get('rounds', '4'));
  const godOpts = JSON.parse(get('god', '{}'));
  for (let gi = 0; gi < games; gi++) {
    const g = gi + offset;
    const { settings, godSeat } = settingsOf(g, sizes);
    const brain = new GodBrain(1000 + g * 13 + godSeat, godOpts);
    let k = 0;
    const god: Bot = {
      type: 'god',
      async nextAttack(s, c) {
        const before = s.turn < rounds ? structuredClone(s) : null;
        brain.lastRescore = null;
        const mv = brain.decideAttack(s, c);
        const r = brain.lastRescore as Decision | null;
        if (before && mv && r && r.cands.length > 1 && r.anchor >= 0) {
          const d: Decision = { id: `${g}.${k++}`, g, turn: s.turn, godSeat, state: before, lastTo: r.lastTo, cands: r.cands, anchor: r.anchor, chosen: mv.from * 1024 + mv.to };
          appendFileSync(out, JSON.stringify(d) + '\n');
        }
        return mv;
      },
      placePower: async (s, c) => brain.decidePower(s, c),
    };
    const opp = createBot('master', { seed: 1000 + g * 13 + (1 - godSeat), master: { sync: true } });
    const bots = godSeat === 0 ? [god, opp] : [opp, god];
    // only the opening is logged: the match stops after `rounds` rounds
    await runMatch(settings, { seed: 5000 + g, bots, maxRounds: rounds, ctx: { speedMs: speed } });
    process.stderr.write('.');
  }
} else if (mode === 'oracle') {
  const all = readDecisions();
  const from = Number(get('from', '0'));
  const to = Math.min(all.length, Number(get('to', String(all.length))));
  const K = Number(get('k', '16'));
  const mp = Number(get('mp', '300'));
  for (let di = from; di < to; di++) {
    const d = all[di];
    const wins: number[][] = [];
    for (const mv of d.cands) {
      const w: number[] = [];
      for (let k = 0; k < K; k++) {
        const s = structuredClone(d.state);
        s.rng = new Rng(0x5eed + k * 7919 + d.g * 31).state();
        const ev = attack(s, mv >> 10, mv & 1023);
        if (typeof ev === 'string') throw new Error(`illegal candidate ${mv} in ${d.id}: ${ev}`);
        // the engine ends bot-only matches at the first fight ("no human left"); the arena undoes that
        if (s.ended && s.ended.winner === -1 && alivePlayers(s).length > 1) s.ended = null;
        const bots = [0, 1].map((p) => createBot('master', { seed: 900 + k * 2 + p, master: { sync: true, playouts: mp } }));
        const res = s.ended ? { winner: s.ended.winner } : await runMatch(s.settings, { seed: 1, state: s, bots, maxRounds: 200, ctx: { speedMs: 0 } });
        if (args.has("debug")) console.log(d.id, mv, k, res.winner, (res as { rounds?: number }).rounds);
        w.push(res.winner === d.godSeat ? 1 : 0);
      }
      wins.push(w);
    }
    appendFileSync(out, JSON.stringify({ id: d.id, cands: d.cands, anchor: d.anchor, chosen: d.chosen, wins }) + '\n');
    process.stderr.write('.');
  }
} else if (mode === 'rollouts') {
  const all = readDecisions();
  const from = Number(get('from', '0'));
  const to = Math.min(all.length, Number(get('to', String(all.length))));
  const n = Number(get('n', '200'));
  const variants: Record<string, object> = JSON.parse(get('variants', '{"base":{}}'));
  for (let di = from; di < to; di++) {
    const d = all[di];
    const res: Record<string, { mean: number[]; gain: number[]; sd: number[]; ms: number }> = {};
    for (const [name, o] of Object.entries(variants)) {
      const brain = new GodBrain(4242, o);
      const t0 = performance.now();
      const vals = brain.rescoreProbe(d.state, d.lastTo, d.cands, n, 0x1234567 ^ di);
      const ms = performance.now() - t0;
      const a = vals[0];
      const mean = vals.map((v) => v.reduce((x, y) => x + y, 0) / v.length);
      const gain: number[] = [];
      const sd: number[] = [];
      for (const v of vals) {
        let m = 0;
        let q = 0;
        for (let i = 0; i < v.length; i++) {
          const x = v[i] - a[i];
          m += x;
          q += x * x;
        }
        m /= v.length;
        gain.push(m);
        sd.push(Math.sqrt(Math.max(0, q / v.length - m * m) * (v.length / Math.max(1, v.length - 1))));
      }
      res[name] = { mean, gain, sd, ms };
    }
    appendFileSync(out, JSON.stringify({ id: d.id, n, res }) + '\n');
    process.stderr.write('.');
  }
}
console.log('');
