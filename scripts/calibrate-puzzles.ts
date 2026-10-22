/**
 * Finds, for every puzzle scenario, the hardest knob (your starting strength) at which a strong
 * stand-in player (Master in your seat) still wins at least TARGET of the games, and reports how an
 * average player (Hunter in your seat) does there.
 * Bots use fixed budgets: Master P playouts, GOD G rollouts per decision (synchronous, deterministic).
 * Run: N=10 P=80 G=60 npx vite-node scripts/calibrate-puzzles.ts [scenario,...] [from-knob]
 */
import { runMatch } from '../src/ai/arena';
import { createBot } from '../src/ai';
import { buildScenario, SCENARIOS, type ScenarioId } from '../src/core/scenarios';
import type { BotType } from '../src/core/types';

const only = process.argv[2]?.split(',') as ScenarioId[] | undefined;
const FROM = Number(process.argv[3] ?? 1);
const N = Number(process.env.N ?? 10);
const PLAYOUTS = Number(process.env.P ?? 80);
const TARGET = Number(process.env.T ?? 0.7);
const GOD = Number(process.env.G ?? 60);

async function rate(id: ScenarioId, proxy: BotType, knob: number) {
  let wins = 0;
  let rounds = 0;
  for (let i = 0; i < N; i++) {
    const seed = 1000 + i * 7919;
    const state = buildScenario(id, seed, knob);
    const bots = state.settings.players.map((p, slot) =>
      createBot(slot === 0 ? proxy : (p as BotType), { seed: seed + slot, master: { playouts: PLAYOUTS }, god: { sync: true, rollouts: GOD } }),
    );
    const res = await runMatch(state.settings, { seed, bots, state, maxRounds: 120 });
    if (res.winner === 0 || res.state.ended?.humanWon) wins++;
    rounds += res.state.turn;
    bots.forEach((b) => b.dispose?.());
  }
  return { wins: wins / N, rounds: rounds / N };
}

const result: Record<string, number> = {};
for (const id of SCENARIOS) {
  if (only && !only.includes(id)) continue;
  let chosen = 12;
  let m = { wins: 0, rounds: 0 };
  for (let knob = FROM; knob <= 12; knob += 0.5) {
    m = await rate(id, 'master', knob);
    if (m.wins >= TARGET) {
      chosen = knob;
      break;
    }
  }
  const h = await rate(id, 'hunter', chosen);
  result[id] = chosen;
  console.log(
    `${id.padEnd(12)} knob=${String(chosen).padEnd(3)} master-as-you ${(m.wins * 100).toFixed(0).padStart(3)}% (${m.rounds.toFixed(1)} rounds)  hunter-as-you ${(h.wins * 100).toFixed(0).padStart(3)}%`,
  );
}
console.log(JSON.stringify(result));
