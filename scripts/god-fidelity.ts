/**
 * Emulator fidelity: how often GOD's emulation of a Master opponent makes the same decision as the real
 * Master. Plays Master-vs-Master matches; at every decision of seat 0 each GOD variant's emulator
 * (GodBrain.emuProbe) is asked for the same position. Attacks: share of identical moves. Placements:
 * share of the placed points that land on the same cells.
 *
 * Usage: npx vite-node scripts/god-fidelity.ts -- games=6 offset=3000 mp=0 speed=200 \
 *          variants='{"base":{},"nominal":{"emuNominal":true}}'
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { GodBrain } from '../src/ai/god';
import type { AttackMove, Bot } from '../src/ai/types';
import type { FieldSize, MatchSettings } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const games = Number(get('games', '6'));
const offset = Number(get('offset', '3000'));
const sizes = get('sizes', 'M,L,XL').split(',') as FieldSize[];
const mp = Number(get('mp', '0'));
const speed = Number(get('speed', '200'));
const duelRules = get('duelRules', '0') === '1';
const verbose = get('verbose', '0') === '1';
const variants: Record<string, object> = JSON.parse(get('variants', '{"base":{}}'));
const players = Number(get('players', '2'));
/** variants whose name starts with "expert" probe Master's expert rollout policy instead of the emulator */
const policyOf = (k: string) => (k.startsWith('expert') ? 'expert' : 'emu');

interface Acc {
  atk: number[];
  atkN: number[];
  pow: number[];
  powN: number[];
}
const acc = new Map<string, Acc>();
for (const v of Object.keys(variants)) acc.set(v, { atk: [0, 0], atkN: [0, 0], pow: [0, 0], powN: [0, 0] });

for (let gi = 0; gi < games; gi++) {
  const g = gi + offset;
  const settings: MatchSettings = {
    kind: 'single',
    size: sizes[g % sizes.length],
    players: Array.from({ length: players }, () => 'master' as const),
    darkness: false,
    symmetry: g % 2 === 1,
    crowded: false,
    unions: false,
    shuffle: false,
    duelRules,
  };
  const brains = Object.fromEntries(Object.entries(variants).map(([k, o]) => [k, new GodBrain(77 + g, o)]));
  const real = createBot('master', { seed: 11 + g, master: { sync: true, playouts: mp > 0 ? mp : undefined } });
  let last: { turn: number; to: number } | null = null;
  const probe: Bot = {
    type: 'master',
    async nextAttack(s, c) {
      const lastTo = last && last.turn === s.turn ? last.to : -1;
      const answers = Object.entries(brains).map(([k, b]) => [k, b.emuProbe(s, lastTo, policyOf(k))] as const);
      const mv = await real.nextAttack(s, c);
      if (mv) {
        const ph = s.turn < 4 ? 0 : 1;
        for (const [k, a] of answers) {
          const m = a as AttackMove | null;
          const x = acc.get(k)!;
          x.atkN[ph]++;
          if (m && m.from === mv.from && m.to === mv.to) x.atk[ph]++;
        }
        last = { turn: s.turn, to: mv.to };
      }
      return mv;
    },
    async placePower(s, c) {
      const answers = Object.entries(brains).map(([k, b]) => [k, b.emuProbe(s)] as const);
      const pl = await real.placePower(s, c);
      const ph = s.turn < 4 ? 0 : 1;
      for (const [k, a] of answers) {
        const m = a as Map<number, number>;
        let same = 0;
        for (const [cell, v] of pl) same += Math.min(v, m.get(cell) ?? 0);
        const x = acc.get(k)!;
        if (verbose && ph === 0 && k === Object.keys(variants)[0]) {
          const info = (cell: number) => {
            const c = s.field.cells[cell];
            let grey = 0;
            let enemy = 0;
            for (const nb of s.field.adj[cell]) {
              const o = s.field.cells[nb].owner;
              if (o < 0) grey++;
              else if (o !== s.current) enemy += s.field.cells[nb].power;
            }
            return `${cell}(${c.power}/${c.maxPower} g${grey} e${enemy})`;
          };
          console.log(`r${s.turn} left ${s.powerLeft} own ${s.field.cells.filter((c) => c.owner === s.current).length}`);
          console.log('  master', [...pl].map(([c, v]) => `${info(c)}+${v}`).join(' '));
          console.log('  model ', [...m].map(([c, v]) => `${info(c)}+${v}`).join(' '));
        }
        x.pow[ph] += same;
        x.powN[ph] += s.powerLeft;
      }
      return pl;
    },
  };
  const others = Array.from({ length: players - 1 }, (_, i) => createBot('master', { seed: 99 + g + 1000 * i, master: { sync: true, playouts: mp > 0 ? mp : undefined } }));
  await runMatch(settings, { seed: 7000 + g, bots: [probe, ...others], maxRounds: 60, ctx: { speedMs: speed } });
  process.stderr.write('.');
}
console.log('');
const pct = (a: number, n: number) => (n ? ((100 * a) / n).toFixed(1) : '-');
for (const [k, x] of acc) {
  console.log(
    `${k}: attacks open ${pct(x.atk[0], x.atkN[0])}% (${x.atkN[0]}) late ${pct(x.atk[1], x.atkN[1])}% (${x.atkN[1]})  ` +
      `placement open ${pct(x.pow[0], x.powN[0])}% late ${pct(x.pow[1], x.powN[1])}%`,
  );
}
