/**
 * GOD decision-time distribution per map size with the real-time budgets (synchronous search, as in the
 * worker). Usage: npx vite-node scripts/god-perf.ts -- sizes=S,M,L,XL,XXL games=2 speed=200 opp=master,hunter
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
const sizes = (args.get('sizes') ?? 'S,M,L,XL,XXL').split(',') as FieldSize[];
const games = Number(args.get('games') ?? '2');
const speed = Number(args.get('speed') ?? '200');
const opp = (args.get('opp') ?? 'master,hunter').split(',') as BotType[];

for (const size of sizes) {
  const att: number[] = [];
  const pow: number[] = [];
  const open: number[] = [];
  const late: number[] = [];
  for (let g = 0; g < games; g++) {
    const types: BotType[] = ['god', ...opp];
    const settings: MatchSettings = {
      kind: 'single',
      size,
      players: types,
      darkness: g % 2 === 1,
      symmetry: false,
      crowded: false,
      unions: false,
      shuffle: false,
      duelRules: false,
    };
    const bots: Bot[] = types.map((t, i) => createBot(t, { seed: 31 * g + i, god: { sync: true }, master: { sync: true, playouts: 200 } }));
    const god = bots[0];
    bots[0] = {
      type: 'god',
      async nextAttack(s, c) {
        const t0 = performance.now();
        const r = await god.nextAttack(s, c);
        const ms = performance.now() - t0;
        att.push(ms);
        (s.turn < 4 ? open : late).push(ms);
        return r;
      },
      async placePower(s, c) {
        const t0 = performance.now();
        const r = await god.placePower(s, c);
        const ms = performance.now() - t0;
        pow.push(ms);
        (s.turn < 4 ? open : late).push(ms);
        return r;
      },
    };
    await runMatch(settings, { seed: 700 + g, bots, maxRounds: 60, ctx: { speedMs: speed } });
  }
  const stat = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const avg = s.reduce((x, y) => x + y, 0) / Math.max(1, s.length);
    return `n=${s.length} avg=${avg.toFixed(0)} p50=${(s[Math.floor(s.length / 2)] ?? 0).toFixed(0)} p95=${(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(0)} max=${(s[s.length - 1] ?? 0).toFixed(0)} ms`;
  };
  console.log(`${size}: attack ${stat(att)} | power ${stat(pow)} | rounds 0-3 ${stat(open)} | later ${stat(late)} | all ${stat([...att, ...pow])}`);
}
