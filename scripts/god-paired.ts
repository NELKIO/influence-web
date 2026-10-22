/**
 * Paired GOD measurements: every offset is played in both seat orders (GOD as A against the opponent as
 * B, and the opponent as A against GOD as B), split into chunks run by a pool of parallel processes of
 * scripts/god-strength.ts. Several GOD variants can be measured in the same run window: their jobs are
 * interleaved, so they share the same machine load (compare a candidate with the baseline this way).
 *
 * Usage: npx vite-node scripts/god-paired.ts -- lo=1000 hi=1120 procs=5 chunk=6 \
 *          variants='{"base":{},"cand":{"emuIters":96}}' extra="gr=0 mp=0 speed=200" [opp=master] [out=file.jsonl]
 *   lo..hi      offsets [lo, hi) (each played twice: both seat orders)
 *   procs       parallel processes (the load: 10 on 10 cores is the slow-device proxy)
 *   variants    name → GodOptions of the GOD side (default {"base":{}})
 *   extra       arguments passed to god-strength (sizes, budgets, speed, duelRules, darkness, mode=ffa ...)
 *   out         append one JSON line per game (variant, offset, size, seat order, GOD won) to this file
 * In ffa mode (extra contains mode=ffa) only the "GOD as A" order exists (GOD rotates through the seats).
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const lo = Number(get('lo', '1000'));
const hi = Number(get('hi', '1120'));
const procs = Number(get('procs', '5'));
const chunk = Number(get('chunk', '6'));
const opp = get('opp', 'master');
const extra = get('extra', 'gr=0 mp=0 speed=200').split(/\s+/).filter(Boolean);
const variants: Record<string, object> = JSON.parse(get('variants', '{"base":{}}'));
const out = args.get('out');
const ffa = extra.includes('mode=ffa');

interface Job {
  variant: string;
  godIsA: boolean;
  offset: number;
  games: number;
}
const jobs: Job[] = [];
for (let o = lo; o < hi; o += chunk) {
  for (const godIsA of ffa ? [true] : [true, false]) {
    for (const v of Object.keys(variants)) jobs.push({ variant: v, godIsA, offset: o, games: Math.min(chunk, hi - o) });
  }
}

interface Tally {
  w: number;
  n: number;
  size: Map<string, [number, number]>;
  order: [number, number][];
  tn: number;
  tsum: number;
  tmax: number;
  rounds: number;
}
const tally = new Map<string, Tally>();
for (const v of Object.keys(variants))
  tally.set(v, { w: 0, n: 0, size: new Map(), order: [[0, 0], [0, 0]], tn: 0, tsum: 0, tmax: 0, rounds: 0 });

function run(job: Job): Promise<void> {
  const opts = JSON.stringify(variants[job.variant]);
  const sideArgs = job.godIsA ? ['a=god', `b=${opp}`, `godA=${opts}`] : [`a=${opp}`, 'b=god', `godB=${opts}`];
  const cmd = ['vite-node', 'scripts/god-strength.ts', '--', 'json=1', `games=${job.games}`, `offset=${job.offset}`, ...sideArgs, ...extra];
  return new Promise((resolve) => {
    const p = spawn('npx', cmd, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('close', () => {
      const line = buf.trim().split('\n').pop() ?? '';
      try {
        const j = JSON.parse(line);
        const t = tally.get(job.variant)!;
        const godSide = job.godIsA ? 'A' : 'B';
        for (const [g, size, win, rounds] of j.perGame as [number, string, string, number][]) {
          const won = win === godSide ? 1 : 0;
          t.w += won;
          t.n++;
          t.rounds += rounds;
          const s = t.size.get(size) ?? [0, 0];
          s[0] += won;
          s[1]++;
          t.size.set(size, s);
          const o = t.order[job.godIsA ? 0 : 1];
          o[0] += won;
          o[1]++;
          if (out) appendFileSync(out, JSON.stringify({ v: job.variant, g, size, godIsA: job.godIsA, won, rounds, extra: extra.join(' ') }) + '\n');
        }
        const tim = j.timing[`god${godSide}`];
        if (tim) {
          t.tn += tim.n;
          t.tsum += tim.avg * tim.n;
          t.tmax = Math.max(t.tmax, tim.max);
        }
      } catch {
        console.error('job failed', JSON.stringify(job), line.slice(0, 200));
      }
      resolve();
    });
  });
}

const t0 = Date.now();
let next = 0;
let done = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    await run(job);
    done++;
    if (done % Math.max(1, Math.floor(jobs.length / 10)) === 0) {
      const parts = [...tally].map(([v, t]) => `${v} ${t.w}/${t.n}`);
      console.log(`[${done}/${jobs.length} ${Math.round((Date.now() - t0) / 1000)}s] ${parts.join('  ')}`);
    }
  }
}
await Promise.all(Array.from({ length: procs }, worker));
const pct = (w: number, n: number) => (n ? ((100 * w) / n).toFixed(1) : '-');
for (const [v, t] of tally) {
  const sizes = [...t.size].map(([k, [w, n]]) => `${k} ${w}/${n} ${pct(w, n)}%`).join(', ');
  console.log(
    `${v}: GOD ${t.w}/${t.n} = ${pct(t.w, t.n)}%  [${sizes}]  orders A ${t.order[0][0]}/${t.order[0][1]} B ${t.order[1][0]}/${t.order[1][1]}` +
      `  god ms avg ${(t.tsum / Math.max(1, t.tn)).toFixed(0)} max ${t.tmax.toFixed(0)}  rounds ${(t.rounds / Math.max(1, t.n)).toFixed(1)}`,
  );
}
console.log(`elapsed ${Math.round((Date.now() - t0) / 1000)} s, procs ${procs}, extra ${extra.join(' ')}`);
