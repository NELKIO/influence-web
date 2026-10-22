/**
 * One cell of a calibration grid: a scenario at one knob with one stand-in in your seat. Prints a JSON
 * line, so a grid of these can run in parallel (e.g. with xargs -P) and be collected afterwards.
 * Run: N=40 P=80 G=60 npx vite-node scripts/calibrate-one.ts <scenario> <knob> <master|hunter|god>
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { buildScenario, type ScenarioId } from '../src/core/scenarios';
import type { BotType } from '../src/core/types';

const [id, knobArg, proxyArg] = process.argv.slice(2);
const knob = Number(knobArg);
const proxy = (proxyArg ?? 'master') as BotType;
const N = Number(process.env.N ?? 40);
const PLAYOUTS = Number(process.env.P ?? 80);
const GOD = Number(process.env.G ?? 60);

let wins = 0;
let rounds = 0;
for (let i = 0; i < N; i++) {
  const seed = 1000 + i * 7919;
  const state = buildScenario(id as ScenarioId, seed, knob);
  const bots = state.settings.players.map((p, slot) =>
    createBot(slot === 0 ? proxy : (p as BotType), { seed: seed + slot, master: { playouts: PLAYOUTS }, god: { sync: true, rollouts: GOD } }),
  );
  const res = await runMatch(state.settings, { seed, bots, state, maxRounds: 120 });
  if (res.winner === 0 || res.state.ended?.humanWon) wins++;
  rounds += res.state.turn;
  bots.forEach((b) => b.dispose?.());
}
console.log(JSON.stringify({ id, knob, proxy, n: N, wins, rate: wins / N, rounds: rounds / N }));
