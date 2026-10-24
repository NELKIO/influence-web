/**
 * One cell of a calibration grid: a scenario at one knob with one stand-in in your seat. Prints a JSON
 * line, so a grid of these can run in parallel (e.g. with xargs -P) and be collected afterwards.
 * Run: N=40 P=80 G=60 O=0 npx vite-node scripts/calibrate-one.ts <scenario> <knob> <master|hunter|god> [size]
 * A size (L, XL, XXL) builds a configurable scenario on that map size, with its recommended seats.
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { buildScenario, type ScenarioId } from '../src/core/scenarios';
import type { BotType, FieldSize } from '../src/core/types';

const [id, knobArg, proxyArg, sizeArg] = process.argv.slice(2);
const knob = Number(knobArg);
const proxy = (proxyArg ?? 'master') as BotType;
const N = Number(process.env.N ?? 40);
const PLAYOUTS = Number(process.env.P ?? 80);
const GOD = Number(process.env.G ?? 60);
/** first game index (to split one grid cell over processes) */
const OFFSET = Number(process.env.O ?? 0);

let wins = 0;
let rounds = 0;
for (let i = OFFSET; i < OFFSET + N; i++) {
  const seed = 1000 + i * 7919;
  const state = buildScenario(id as ScenarioId, seed, knob, undefined, sizeArg ? { size: sizeArg as FieldSize } : undefined);
  const bots = state.settings.players.map((p, slot) =>
    createBot(slot === 0 ? proxy : (p as BotType), { seed: seed + slot, master: { playouts: PLAYOUTS }, god: { sync: true, rollouts: GOD } }),
  );
  const res = await runMatch(state.settings, { seed, bots, state, maxRounds: 120 });
  if (res.winner === 0 || res.state.ended?.humanWon) wins++;
  rounds += res.state.turn;
  bots.forEach((b) => b.dispose?.());
}
console.log(JSON.stringify({ id, knob, proxy, ...(sizeArg ? { size: sizeArg } : {}), offset: OFFSET, n: N, wins, rate: wins / N, rounds: rounds / N }));
