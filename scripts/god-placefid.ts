/**
 * Placement fidelity of GOD's in-rollout models of its OWN placement (round 7). Plays GOD vs Master
 * matches (same seeds and seats as scripts/god-strength.ts). At every placement of GOD it asks each
 * model (GodBrain.placeProbe) and a real-time Master (default options) for the same position, then lets
 * GOD place for real. Reports the share of placed points that land on the same cells (overlap) and how
 * often the cell with the most points agrees, against GOD's real placement and against Master's.
 * At the opponent's placements the models are compared with the real Master placement too.
 *
 * Usage: npx vite-node scripts/god-placefid.ts -- games=10 offset=0 sizes=S,M,L,XL,XXL gr=0 mp=0 speed=200 \
 *          models=model,expert,search:64 [log=file.jsonl] [god={json options}]
 */
import { appendFileSync } from 'node:fs';
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { GodBrain } from '../src/ai/god';
import { MasterBrain } from '../src/ai/master';
import type { Bot } from '../src/ai/types';
import type { BotType, FieldSize, MatchSettings, MatchState } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const games = Number(get('games', '10'));
const offset = Number(get('offset', '0'));
const sizes = get('sizes', 'S,M,L,XL,XXL').split(',') as FieldSize[];
const gr = Number(get('gr', '0'));
const mp = Number(get('mp', '0'));
const speed = Number(get('speed', '200'));
const models = get('models', 'model,expert,search:64').split(',');
const log = args.get('log');
const godOpts = JSON.parse(get('god', '{}'));

/** [opening, later] × reference (god real, master) */
interface Acc {
  ov: number[];
  top: number[];
  us: number;
  calls: number;
}
const newAcc = (): Acc => ({ ov: [0, 0, 0, 0, 0, 0], top: [0, 0, 0, 0, 0, 0], us: 0, calls: 0 });
const acc = new Map<string, Acc>();
for (const m of [...models, 'master']) acc.set(m, newAcc());

const overlap = (a: Map<number, number>, b: Map<number, number>) => {
  let s = 0;
  for (const [c, v] of a) s += Math.min(v, b.get(c) ?? 0);
  return s;
};
const topCell = (a: Map<number, number>) => {
  let best = -1;
  let bv = -1;
  for (const [c, v] of a) if (v > bv || (v === bv && c < best)) (best = c), (bv = v);
  return best;
};

function record(m: string, ph: number, refIdx: number, a: Map<number, number>, ref: Map<number, number>) {
  const x = acc.get(m)!;
  const k = ph * 3 + refIdx;
  x.ov[k] += overlap(a, ref);
  x.top[k] += topCell(a) === topCell(ref) ? 1 : 0;
}

const tot = { pts: [0, 0, 0, 0, 0, 0], dec: [0, 0, 0, 0, 0, 0] };

for (let gi = 0; gi < games; gi++) {
  const g = gi + offset;
  const size = sizes[g % sizes.length];
  const symmetry = Math.floor(g / sizes.length) % 2 === 1;
  const swap = Math.floor(g / (2 * sizes.length)) % 2 === 1 ? g % 2 === 0 : g % 2 === 1;
  const types: BotType[] = swap ? ['master', 'god'] : ['god', 'master'];
  const godSeat = swap ? 1 : 0;
  const settings: MatchSettings = { kind: 'single', size, players: types, darkness: false, symmetry, crowded: false, unions: false, shuffle: false, duelRules: false };
  const brain = new GodBrain(1000 + g * 13 + godSeat, { ...(gr > 0 ? { rollouts: gr } : {}), ...godOpts });
  const probe = new GodBrain(4242 + g, {});
  const ref = new MasterBrain(777 + g, mp > 0 ? { playouts: mp } : {});
  const god: Bot = {
    type: 'god',
    async nextAttack(s, c) {
      return brain.decideAttack(s, c);
    },
    async placePower(s, c) {
      const ph = s.turn < 4 ? 0 : 1;
      const left = s.powerLeft;
      const outs = models.map((m) => {
        const t = performance.now();
        const r = probe.placeProbe(s, m);
        const a = acc.get(m)!;
        a.us += (performance.now() - t) * 1000;
        a.calls++;
        return r;
      });
      const mpl = ref.decidePower(structuredClone(s), c);
      const real = brain.decidePower(s, c);
      tot.pts[ph * 3] += left;
      tot.pts[ph * 3 + 1] += left;
      tot.dec[ph * 3]++;
      tot.dec[ph * 3 + 1]++;
      models.forEach((m, i) => {
        record(m, ph, 0, outs[i], real);
        record(m, ph, 1, outs[i], mpl);
      });
      record('master', ph, 0, mpl, real);
      if (log) appendFileSync(log, JSON.stringify({ g, size, side: 'god', turn: s.turn, me: s.current, left, owner: s.field.cells.map((c) => c.owner), power: s.field.cells.map((c) => c.power), real: [...real], master: [...mpl], models: Object.fromEntries(models.map((m, i) => [m, [...outs[i]]])) }) + '\n');
      return real;
    },
  };
  const opp = createBot('master', { seed: 1000 + g * 13 + (1 - godSeat), master: { sync: true, playouts: mp > 0 ? mp : undefined } });
  const oppBot: Bot = {
    type: 'master',
    nextAttack: (s, c) => opp.nextAttack(s, c),
    async placePower(s: MatchState, c) {
      const ph = s.turn < 4 ? 0 : 1;
      const outs = models.map((m) => probe.placeProbe(s, m));
      const real = await opp.placePower(s, c);
      tot.pts[ph * 3 + 2] += s.powerLeft;
      tot.dec[ph * 3 + 2]++;
      models.forEach((m, i) => record(m, ph, 2, outs[i], real));
      return real;
    },
  };
  const bots = godSeat === 0 ? [god, oppBot] : [oppBot, god];
  await runMatch(settings, { seed: 5000 + g, bots, maxRounds: 200, ctx: { speedMs: speed } });
  process.stderr.write('.');
}
console.log('');
const pct = (a: number, n: number) => (n ? ((100 * a) / n).toFixed(1) : '-');
console.log('overlap of placed points (top cell agreement) — vs GOD real | vs Master (same position) | vs real Master opponent');
for (const [m, x] of acc) {
  const cols: string[] = [];
  for (const ph of [0, 1])
    for (const r of [0, 1, 2]) {
      const k = ph * 3 + r;
      if (m === 'master' && r > 0) continue;
      cols.push(`${['open', 'late'][ph]}/${['god', 'mst', 'opp'][r]} ${pct(x.ov[k], tot.pts[k])}% (${pct(x.top[k], tot.dec[k])}%)`);
    }
  console.log(`${m.padEnd(10)} ${cols.join('  ')}${x.calls ? `  ${(x.us / x.calls / 1000).toFixed(2)} ms/call` : ''}`);
}
console.log(`decisions: god open ${tot.dec[0]} late ${tot.dec[3]}, opp open ${tot.dec[2]} late ${tot.dec[5]}`);
