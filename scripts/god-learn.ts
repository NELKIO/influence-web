/**
 * Self-play data for GOD's learned evaluation.
 *
 * Plays bot matches and records, at the end of every attack phase, the features of the position from the
 * point of view of the player who just attacked (src/ai/godSim.ts phaseFeatures) together with the final
 * result (1 = that player won the match). scripts/god-fit.py fits a logistic model on the rows; the weights
 * go into LEARNED_* in src/ai/godSim.ts.
 *
 * Usage: npx vite-node scripts/god-learn.ts -- games=200 offset=0 bots=master,master sizes=M,L,XL mp=300
 *        out=/tmp/god-data-0.csv [players=2] [duelRules=0] [gr=300]
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createBot } from '../src/ai';
import { FastRng, NF, Sim, Topo, phaseFeatures } from '../src/ai/godSim';
import { addPower, alivePlayers, attack, createMatch, endAttack, finishTurn } from '../src/core/engine';
import type { BotType, FieldSize, MatchSettings, MatchState } from '../src/core/types';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=');
  if (i > 0) args.set(a.slice(0, i), a.slice(i + 1));
}
const get = (k: string, d: string) => args.get(k) ?? d;
const games = Number(get('games', '100'));
const offset = Number(get('offset', '0'));
const pool = get('bots', 'master,master').split(',') as BotType[];
const sizes = get('sizes', 'M,L,XL').split(',') as FieldSize[];
const nPlayers = Number(get('players', '2'));
const duelRules = get('duelRules', '0') === '1';
const mp = Number(get('mp', '300'));
const gr = Number(get('gr', '300'));
const out = get('out', '/tmp/god-data.csv');
writeFileSync(out, '');

function simOf(state: MatchState, topo: Topo): Sim {
  const sim = new Sim(topo, new FastRng(1));
  state.field.cells.forEach((c, i) => {
    sim.owner[i] = c.owner;
    sim.power[i] = c.owner < 0 ? 0 : c.power;
  });
  sim.recount();
  return sim;
}

const f = new Float64Array(NF);
for (let gi = 0; gi < games; gi++) {
  const g = gi + offset;
  const size = sizes[g % sizes.length];
  const types: BotType[] = Array.from({ length: nPlayers }, (_, i) => pool[(g + i) % pool.length]);
  const settings: MatchSettings = {
    kind: duelRules ? 'duelTraining' : 'single',
    size,
    players: types,
    darkness: false,
    symmetry: g % 2 === 1,
    crowded: false,
    unions: false,
    shuffle: false,
    duelRules,
  };
  const s = createMatch(settings, { seed: 90_000 + g });
  const topo = new Topo(s);
  const bots = types.map((t, i) => createBot(t, { seed: g * 7 + i, master: { sync: true, playouts: mp }, god: { sync: true, rollouts: gr } }));
  const rows: { slot: number; turn: number; feats: string }[] = [];
  const ctx = { speedMs: 0 };
  while (!s.ended && s.turn < 150) {
    const me = s.current;
    for (let k = 0; k < 2000; k++) {
      const mv = await bots[me].nextAttack(s, ctx);
      if (!mv) break;
      attack(s, mv.from, mv.to);
      if (s.ended && s.ended.winner === -1 && alivePlayers(s).length > 1) s.ended = null;
      if (s.ended) break;
    }
    if (s.ended) break;
    phaseFeatures(simOf(s, topo), me, f);
    rows.push({ slot: me, turn: s.turn, feats: Array.from(f, (x) => +x.toFixed(5)).join(',') });
    endAttack(s);
    for (const [c, n] of await bots[me].placePower(s, ctx)) addPower(s, c, n);
    finishTurn(s);
  }
  const alive = alivePlayers(s);
  const winner = s.ended ? s.ended.winner : alive.length === 1 ? alive[0] : -1;
  if (winner < 0) continue;
  appendFileSync(out, rows.map((r) => `${r.slot === winner ? 1 : 0},${g},${size},${nPlayers},${r.turn},${r.feats}`).join('\n') + '\n');
}
