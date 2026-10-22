/**
 * GOD decision diagnostics: plays matches with a GodBrain in one seat and logs every decision (round,
 * kind, time, tree iterations, emulated rollouts, whether the re-scoring changed the tree's choice) and the
 * evaluation trajectory. Usage: npx vite-node scripts/god-diag.ts -- games=4 sizes=L offset=1000 \
 *   gr=0 mp=0 speed=200 god='{}' [verbose=1]
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { GodBrain } from '../src/ai/god';
import type { Bot } from '../src/ai/types';
import type { BotType, FieldSize, MatchSettings } from '../src/core/types';
import { cellCount, scoreOf } from '../src/core/engine';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const games = Number(get('games', '4'));
const sizes = get('sizes', 'M,L,XL').split(',') as FieldSize[];
const offset = Number(get('offset', '1000'));
const gr = Number(get('gr', '0'));
const mp = Number(get('mp', '0'));
const speed = Number(get('speed', '200'));
const godOpts = JSON.parse(get('god', '{}'));
const verbose = get('verbose', '0') === '1';
const opp = get('opp', 'master') as BotType;

const agg = new Map<string, { n: number; ms: number; it: number; emu: number; changed: number; emuN: number }>();
const rec = (k: string, ms: number, it: number, emu: number | undefined, changed: boolean | undefined) => {
  const a = agg.get(k) ?? { n: 0, ms: 0, it: 0, emu: 0, changed: 0, emuN: 0 };
  a.n++;
  a.ms += ms;
  a.it += it;
  if (emu) {
    a.emu += emu;
    a.emuN++;
    if (changed) a.changed++;
  }
  agg.set(k, a);
};

let wins = 0;
for (let gi = 0; gi < games; gi++) {
  const g = gi + offset;
  const size = sizes[g % sizes.length];
  const godSeat = gi % 2;
  const types: BotType[] = godSeat === 0 ? ['god', opp] : [opp, 'god'];
  const settings: MatchSettings = {
    kind: 'single',
    size,
    players: types,
    darkness: get('darkness', '0') === '1',
    symmetry: Math.floor(g / sizes.length) % 2 === 1,
    crowded: false,
    unions: false,
    shuffle: false,
    duelRules: get('duelRules', '0') === '1',
  };
  const brain = new GodBrain(1000 + g * 13, { rollouts: gr > 0 ? gr : undefined, ...godOpts });
  const traj: string[] = [];
  const god: Bot = {
    type: 'god',
    async nextAttack(s) {
      const m = brain.decideAttack(s, { speedMs: speed });
      const i = brain.lastInfo;
      const k = `${s.turn < 4 ? 'open' : 'late'}-atk`;
      rec(k, i.ms, i.rollouts, i.emu, i.changed);
      if (verbose) console.log(`  r${s.turn} atk ${i.ms.toFixed(0)}ms it ${i.rollouts} emu ${i.emu ?? 0} cand ${i.candidates} ${i.changed ? 'CHANGED' : ''}`);
      return m;
    },
    async placePower(s) {
      const p = brain.decidePower(s, { speedMs: speed });
      const i = brain.lastInfo;
      rec(`${s.turn < 4 ? 'open' : 'late'}-pow`, i.ms, i.rollouts, i.emu, i.changed);
      const me = s.current;
      const o = 1 - me;
      traj.push(`r${s.turn}:${cellCount(s, me)}/${scoreOf(s, me)} vs ${cellCount(s, o)}/${scoreOf(s, o)}`);
      if (verbose) console.log(`  r${s.turn} pow ${i.ms.toFixed(0)}ms emu ${i.emu ?? 0} cand ${i.candidates} ${i.changed ? 'CHANGED' : ''}`);
      return p;
    },
  };
  const bots = types.map((t, i) => (t === 'god' ? god : createBot(t, { seed: 1000 + g * 13 + i, master: { sync: true, playouts: mp > 0 ? mp : undefined } })));
  const r = await runMatch(settings, { seed: 5000 + g, bots, maxRounds: 200, ctx: { speedMs: speed } });
  const won = r.winner === godSeat;
  if (won) wins++;
  console.log(`game ${g} ${size}${settings.symmetry ? 's' : ''} god seat ${godSeat}: ${won ? 'WIN' : 'loss'} (${r.rounds} rounds) ${traj.slice(0, 6).join('  ')}`);
}
console.log(`GOD ${wins}/${games}`);
for (const [k, a] of [...agg].sort()) {
  console.log(
    `${k}: n ${a.n} avg ${(a.ms / a.n).toFixed(0)} ms, iters ${(a.it / a.n).toFixed(0)}, emu rollouts ${(a.emu / Math.max(1, a.emuN)).toFixed(1)} over ${a.emuN} decisions, changed ${a.changed}`,
  );
}
